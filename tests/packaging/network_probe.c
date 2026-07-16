#define _GNU_SOURCE

#include <errno.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define KALEIDOSCOPE_X32_SYSCALL_BIT 0x40000000U
#endif

static int socket_is_denied(int domain) {
    int descriptor;

    errno = 0;
    descriptor = socket(domain, SOCK_STREAM, 0);
    return descriptor == -1 && errno == EACCES;
}

static int raw_socket_is_denied(int domain) {
    long descriptor;

    errno = 0;
    descriptor = syscall(SYS_socket, domain, SOCK_STREAM, 0);
    return descriptor == -1 && errno == EACCES;
}

static int socketpair_is_denied(int domain) {
    int descriptors[2];

    errno = 0;
    return socketpair(domain, SOCK_STREAM, 0, descriptors) == -1 &&
           errno == EACCES;
}

static int raw_socketpair_is_denied(int domain) {
    int descriptors[2];
    long result;

    errno = 0;
    result = syscall(SYS_socketpair, domain, SOCK_STREAM, 0, descriptors);
    return result == -1 && errno == EACCES;
}

#if defined(__x86_64__)
static int x32_syscalls_are_denied(void) {
    long result;

    errno = 0;
    result = syscall(KALEIDOSCOPE_X32_SYSCALL_BIT | SYS_socket,
                     AF_INET, SOCK_STREAM, 0);
    if (result != -1 || errno != EACCES) {
        return 0;
    }
    errno = 0;
    result = syscall(KALEIDOSCOPE_X32_SYSCALL_BIT | SYS_io_uring_setup,
                     1, NULL);
    return result == -1 && errno == EACCES;
}
#endif

static int io_uring_is_denied(void) {
    long result;

    errno = 0;
    result = syscall(SYS_io_uring_setup, 1, NULL);
    if (result != -1 || errno != EACCES) {
        return 0;
    }
    errno = 0;
    result = syscall(SYS_io_uring_enter, -1, 0, 0, 0, NULL, 0);
    if (result != -1 || errno != EACCES) {
        return 0;
    }
    errno = 0;
    result = syscall(SYS_io_uring_register, -1, 0, NULL, 0);
    return result == -1 && errno == EACCES;
}

int main(void) {
    static const int denied_domains[] = {
        AF_INET,
        AF_INET6,
        AF_PACKET,
        AF_NETLINK,
    };
    int local_descriptor;
    size_t index;

    for (index = 0; index < sizeof(denied_domains) / sizeof(denied_domains[0]);
         index++) {
        if (!socket_is_denied(denied_domains[index])) {
            return 1;
        }
        if (!raw_socket_is_denied(denied_domains[index])) {
            return 2;
        }
        if (!socketpair_is_denied(denied_domains[index])) {
            return 3;
        }
        if (!raw_socketpair_is_denied(denied_domains[index])) {
            return 4;
        }
    }
    if (!io_uring_is_denied()) {
        return 5;
    }
#if defined(__x86_64__)
    if (!x32_syscalls_are_denied()) {
        return 6;
    }
#endif
    local_descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
    if (local_descriptor == -1) {
        return 7;
    }
    close(local_descriptor);
    {
        int local_descriptors[2];

        if (socketpair(AF_UNIX, SOCK_STREAM, 0, local_descriptors) == -1) {
            return 8;
        }
        close(local_descriptors[0]);
        close(local_descriptors[1]);
    }
    return 0;
}
