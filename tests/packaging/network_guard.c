#define _GNU_SOURCE

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <limits.h>
#include <sched.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__)
#define KALEIDOSCOPE_AUDIT_ARCH AUDIT_ARCH_X86_64
#define KALEIDOSCOPE_X32_SYSCALL_BIT 0x40000000U
#elif defined(__aarch64__)
#define KALEIDOSCOPE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "Unsupported architecture for the artifact network guard"
#endif

extern char **environ;

struct runner_paths {
    char *temporary;
    char *actions;
    char *tool_cache;
};

static int starts_with(const char *value, const char *prefix) {
    return strncmp(value, prefix, strlen(prefix)) == 0;
}

static int should_scrub_environment(const char *assignment) {
    static const char *credential_names[] = {
        "ALL_PROXY",
        "BASH_ENV",
        "CI_JOB_TOKEN",
        "DBUS_SESSION_BUS_ADDRESS",
        "DOCKER_HOST",
        "ENV",
        "GH_ENTERPRISE_TOKEN",
        "GH_TOKEN",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NODE_AUTH_TOKEN",
        "NO_PROXY",
        "NPM_TOKEN",
        "PYPI_API_TOKEN",
        "SSH_AGENT_PID",
        "SSH_AUTH_SOCK",
        "TWINE_PASSWORD",
        "TWINE_USERNAME",
        "all_proxy",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    };
    const char *equals = strchr(assignment, '=');
    size_t name_length;
    size_t index;

    if (equals == NULL) {
        return 0;
    }
    name_length = (size_t)(equals - assignment);
    if ((name_length >= strlen("ACTIONS_") &&
         starts_with(assignment, "ACTIONS_")) ||
        (name_length >= strlen("GITHUB_") &&
         starts_with(assignment, "GITHUB_")) ||
        (name_length >= strlen("RUNNER_") &&
         starts_with(assignment, "RUNNER_")) ||
        (name_length >= strlen("GIT_") && starts_with(assignment, "GIT_")) ||
        (name_length >= strlen("LD_") && starts_with(assignment, "LD_"))) {
        return 1;
    }
    for (index = 0;
         index < sizeof(credential_names) / sizeof(credential_names[0]);
         index++) {
        const char *name = credential_names[index];

        if (name_length == strlen(name) && strncmp(assignment, name, name_length) == 0) {
            return 1;
        }
    }
    return 0;
}

static int directory_exists(const char *path) {
    struct stat status;

    return path != NULL && path[0] == '/' && stat(path, &status) == 0 &&
           S_ISDIR(status.st_mode);
}

static void free_runner_paths(struct runner_paths *paths) {
    free(paths->temporary);
    free(paths->actions);
    free(paths->tool_cache);
    paths->temporary = NULL;
    paths->actions = NULL;
    paths->tool_cache = NULL;
}

static int capture_runner_paths(struct runner_paths *paths) {
    const char *temporary = getenv("RUNNER_TEMP");
    const char *tool_cache = getenv("RUNNER_TOOL_CACHE");
    const char *temporary_separator;
    size_t work_root_length;
    int actions_length;

    memset(paths, 0, sizeof(*paths));
    if (temporary == NULL && tool_cache == NULL) {
        return 0;
    }
    if (!directory_exists(temporary) || !directory_exists(tool_cache)) {
        errno = ENOENT;
        return -1;
    }
    paths->temporary = strdup(temporary);
    paths->tool_cache = strdup(tool_cache);
    if (paths->temporary == NULL || paths->tool_cache == NULL) {
        free_runner_paths(paths);
        return -1;
    }
    temporary_separator = strrchr(temporary, '/');
    if (temporary_separator == NULL || temporary_separator == temporary) {
        free_runner_paths(paths);
        errno = EINVAL;
        return -1;
    }
    work_root_length = (size_t)(temporary_separator - temporary);
    actions_length = snprintf(NULL, 0, "%.*s/_actions", (int)work_root_length,
                              temporary);
    if (actions_length < 0 || actions_length >= PATH_MAX) {
        free_runner_paths(paths);
        errno = EOVERFLOW;
        return -1;
    }
    paths->actions = malloc((size_t)actions_length + 1);
    if (paths->actions == NULL) {
        free_runner_paths(paths);
        return -1;
    }
    snprintf(paths->actions, (size_t)actions_length + 1, "%.*s/_actions",
             (int)work_root_length, temporary);
    if (!directory_exists(paths->actions)) {
        free_runner_paths(paths);
        errno = ENOENT;
        return -1;
    }
    return 0;
}

static int scrub_environment(void) {
    char **entry = environ;

    while (*entry != NULL) {
        const char *assignment = *entry;
        const char *equals = strchr(assignment, '=');

        if (equals != NULL && should_scrub_environment(assignment)) {
            size_t name_length = (size_t)(equals - assignment);
            char *name = malloc(name_length + 1);

            if (name == NULL) {
                return -1;
            }
            memcpy(name, assignment, name_length);
            name[name_length] = '\0';
            if (unsetenv(name) == -1) {
                free(name);
                return -1;
            }
            free(name);
            entry = environ;
            continue;
        }
        entry++;
    }
    return 0;
}

static int write_all(int descriptor, const char *value) {
    size_t offset = 0;
    size_t length = strlen(value);

    while (offset < length) {
        ssize_t written = write(descriptor, value + offset, length - offset);

        if (written == -1) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        offset += (size_t)written;
    }
    return 0;
}

static int write_text_file(const char *path, const char *value) {
    int descriptor = open(path, O_WRONLY | O_CLOEXEC);
    int result;
    int saved_errno;

    if (descriptor == -1) {
        return -1;
    }
    result = write_all(descriptor, value);
    saved_errno = errno;
    if (close(descriptor) == -1 && result == 0) {
        return -1;
    }
    errno = saved_errno;
    return result;
}

static int write_identity_map(const char *path, unsigned int outer_id) {
    char mapping[64];
    int length = snprintf(mapping, sizeof(mapping), "0 %u 1\n", outer_id);

    if (length < 0 || (size_t)length >= sizeof(mapping)) {
        errno = EOVERFLOW;
        return -1;
    }
    return write_text_file(path, mapping);
}

static int mount_private_tmpfs(const char *path, const char *options) {
    return mount("tmpfs", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC,
                 options);
}

static int numeric_name(const char *name) {
    const unsigned char *character = (const unsigned char *)name;

    if (*character == '\0') {
        return 0;
    }
    while (*character != '\0') {
        if (!isdigit(*character)) {
            return 0;
        }
        character++;
    }
    return 1;
}

static int mask_outer_processes(void) {
    const char *empty = "/run/kaleidoscope-empty-proc";
    DIR *proc;
    struct dirent *entry;
    int result = 0;

    if (mkdir(empty, 0000) == -1) {
        return -1;
    }
    proc = opendir("/proc");
    if (proc == NULL) {
        return -1;
    }
    errno = 0;
    while ((entry = readdir(proc)) != NULL) {
        char path[PATH_MAX];
        int length;

        if (!numeric_name(entry->d_name)) {
            continue;
        }
        length = snprintf(path, sizeof(path), "/proc/%s", entry->d_name);
        if (length < 0 || (size_t)length >= sizeof(path)) {
            errno = EOVERFLOW;
            result = -1;
            break;
        }
        if (mount(empty, path, NULL, MS_BIND, NULL) == -1 && errno != ENOENT) {
            result = -1;
            break;
        }
        errno = 0;
    }
    if (result == 0 && errno != 0) {
        result = -1;
    }
    if (closedir(proc) == -1 && result == 0) {
        result = -1;
    }
    return result;
}

static int isolate_runner_paths(const struct runner_paths *paths) {
    char private_home[PATH_MAX];
    int length;

    if (paths->temporary == NULL) {
        return 0;
    }
    if (mount_private_tmpfs(paths->temporary, "mode=700,size=256m") == -1 ||
        mount_private_tmpfs(paths->actions, "mode=555,size=16m") == -1 ||
        mount(paths->tool_cache, paths->tool_cache, NULL, MS_BIND | MS_REC,
              NULL) == -1 ||
        mount(NULL, paths->tool_cache, NULL,
              MS_BIND | MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV,
              NULL) == -1) {
        return -1;
    }
    length = snprintf(private_home, sizeof(private_home), "%s/home",
                      paths->temporary);
    if (length < 0 || (size_t)length >= sizeof(private_home) ||
        mkdir(private_home, 0700) == -1 || setenv("HOME", private_home, 1) == -1 ||
        setenv("TMPDIR", paths->temporary, 1) == -1 ||
        setenv("KALEIDOSCOPE_PRIVATE_RUNNER_TEMP", paths->temporary, 1) == -1 ||
        setenv("KALEIDOSCOPE_PRIVATE_ACTIONS_DIR", paths->actions, 1) == -1 ||
        setenv("KALEIDOSCOPE_READONLY_TOOL_CACHE", paths->tool_cache, 1) == -1) {
        return -1;
    }
    return 0;
}

static int install_private_namespaces(const struct runner_paths *paths) {
    uid_t outer_uid = getuid();
    gid_t outer_gid = getgid();

    if (unshare(CLONE_NEWUSER) == -1) {
        return -1;
    }
    if (write_text_file("/proc/self/setgroups", "deny\n") == -1 &&
        errno != ENOENT) {
        return -1;
    }
    if (write_identity_map("/proc/self/uid_map", (unsigned int)outer_uid) == -1 ||
        write_identity_map("/proc/self/gid_map", (unsigned int)outer_gid) == -1) {
        return -1;
    }
    if (setresgid(0, 0, 0) == -1 || setresuid(0, 0, 0) == -1) {
        return -1;
    }
    if (unshare(CLONE_NEWNS | CLONE_NEWNET | CLONE_NEWPID) == -1) {
        return -1;
    }
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) == -1) {
        return -1;
    }
    if (mount("tmpfs", "/run", "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC,
              "mode=755,size=16m") == -1) {
        return -1;
    }
    if (isolate_runner_paths(paths) == -1) {
        return -1;
    }
    if (mask_outer_processes() == -1) {
        return -1;
    }
    return setenv("KALEIDOSCOPE_NETWORK_NAMESPACE_ACTIVE", "1", 1);
}

static int install_network_filter(void) {
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                 KALEIDOSCOPE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 offsetof(struct seccomp_data, nr)),
    #if defined(__x86_64__)
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
             KALEIDOSCOPE_X32_SYSCALL_BIT, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_enter, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_register, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_mount, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_umount2, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_pivot_root, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_setns, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_unshare, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #ifdef SYS_open_tree
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_open_tree, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_move_mount
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_move_mount, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_fsopen
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fsopen, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_fsconfig
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fsconfig, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_fsmount
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_fsmount, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_mount_setattr
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_mount_setattr, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
    #endif
    #ifdef SYS_clone3
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),
    #endif
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
             offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K,
             CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS |
                 CLONE_NEWPID | CLONE_NEWUSER | CLONE_NEWUTS,
             0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                 offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
             offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog filter = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions,
    };

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1) {
        return -1;
    }
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter);
}

int main(int argc, char **argv) {
    struct runner_paths runner_paths;
    pid_t child;
    int status;

    if (argc < 2) {
        fprintf(stderr, "usage: network_guard COMMAND [ARG ...]\n");
        return 2;
    }
    if (capture_runner_paths(&runner_paths) == -1) {
        perror("capture runner paths");
        return 1;
    }
    if (scrub_environment() == -1) {
        perror("scrub artifact environment");
        free_runner_paths(&runner_paths);
        return 1;
    }
    if (install_private_namespaces(&runner_paths) == -1) {
        perror("install private artifact namespaces");
        free_runner_paths(&runner_paths);
        return 1;
    }
    free_runner_paths(&runner_paths);
    child = fork();
    if (child == -1) {
        perror("enter private PID namespace");
        return 1;
    }
    if (child > 0) {
        while (waitpid(child, &status, 0) == -1) {
            if (errno != EINTR) {
                perror("wait for guarded command");
                return 1;
            }
        }
        if (WIFEXITED(status)) {
            return WEXITSTATUS(status);
        }
        if (WIFSIGNALED(status)) {
            return 128 + WTERMSIG(status);
        }
        return 1;
    }
    if (setenv("KALEIDOSCOPE_PID_NAMESPACE_ACTIVE", "1", 1) == -1) {
        perror("mark private PID namespace active");
        return 1;
    }
    if (install_network_filter() == -1) {
        perror("install seccomp network filter");
        return 1;
    }
    if (setenv("KALEIDOSCOPE_NETWORK_GUARD_ACTIVE", "1", 1) == -1) {
        perror("mark seccomp network filter active");
        return 1;
    }
    execvp(argv[1], &argv[1]);
    perror("exec guarded command");
    return 1;
}
