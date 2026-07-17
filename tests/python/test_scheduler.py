from __future__ import annotations

from concurrent.futures import Future

import pytest

from kaleidoscope.scheduler import FrameSetScheduler, ScheduledFrame


def test_scheduler_requires_a_positive_in_flight_bound() -> None:
    with pytest.raises(ValueError, match="must be positive"):
        FrameSetScheduler(max_in_flight=0)


def test_closed_scheduler_ignores_replacement_work() -> None:
    submitted: list[str] = []
    scheduler = FrameSetScheduler(max_in_flight=1)
    scheduler.close()

    scheduler.replace_pending(
        [
            ScheduledFrame(
                fairness_key="Source",
                submit=lambda: submitted.append("Source") or Future(),
                completed=lambda _: None,
                submission_failed=lambda _: None,
            )
        ]
    )

    assert submitted == []
    assert scheduler.in_flight == 0


def test_scheduler_submits_frame_set_members_fairly_within_the_bound() -> None:
    scheduler = FrameSetScheduler(max_in_flight=1)
    source_future: Future[object] = Future()
    filtered_future: Future[object] = Future()
    submitted: list[str] = []
    completed: list[str] = []

    def frame(clip_id: str, future: Future[object]) -> ScheduledFrame:
        return ScheduledFrame(
            fairness_key=clip_id,
            submit=lambda: submitted.append(clip_id) or future,
            completed=lambda _: completed.append(clip_id),
            submission_failed=lambda error: (_ for _ in ()).throw(error),
        )

    scheduler.replace_pending(
        [frame("Source", source_future), frame("Filtered", filtered_future)]
    )

    assert submitted == ["Source"]
    assert scheduler.in_flight == 1

    source_future.set_result(object())

    assert submitted == ["Source", "Filtered"]
    assert completed == ["Source"]
    assert scheduler.in_flight == 1

    filtered_future.set_result(object())

    assert completed == ["Source", "Filtered"]
    assert scheduler.in_flight == 0


def test_scheduler_replaces_unsubmitted_stale_members_as_a_set() -> None:
    scheduler = FrameSetScheduler(max_in_flight=1)
    in_flight: Future[object] = Future()
    newest: Future[object] = Future()
    submitted: list[str] = []

    def frame(clip_id: str, future: Future[object]) -> ScheduledFrame:
        return ScheduledFrame(
            fairness_key=clip_id,
            submit=lambda: submitted.append(clip_id) or future,
            completed=lambda _: None,
            submission_failed=lambda error: (_ for _ in ()).throw(error),
        )

    scheduler.replace_pending([frame("old-a", in_flight), frame("old-b", Future())])
    scheduler.replace_pending([frame("new-a", newest)])

    in_flight.set_result(object())

    assert submitted == ["old-a", "new-a"]

    newest.set_result(object())
    assert scheduler.in_flight == 0


def test_scheduler_rotates_latest_sets_after_the_last_submitted_clip() -> None:
    scheduler = FrameSetScheduler(max_in_flight=1)
    old_source: Future[object] = Future()
    newest_source: Future[object] = Future()
    newest_filtered: Future[object] = Future()
    submitted: list[str] = []

    def frame(clip_id: str, future: Future[object]) -> ScheduledFrame:
        return ScheduledFrame(
            fairness_key=clip_id,
            submit=lambda: submitted.append(clip_id) or future,
            completed=lambda _: None,
            submission_failed=lambda error: (_ for _ in ()).throw(error),
        )

    scheduler.replace_pending(
        [frame("Source", old_source), frame("Filtered", Future())]
    )
    scheduler.replace_pending(
        [
            frame("Source", newest_source),
            frame("Filtered", newest_filtered),
        ]
    )

    old_source.set_result(object())
    assert submitted == ["Source", "Filtered"]

    newest_filtered.set_result(object())
    assert submitted == ["Source", "Filtered", "Source"]

    newest_source.set_result(object())
    assert scheduler.in_flight == 0


def test_scheduler_releases_a_slot_when_callback_registration_fails() -> None:
    class BrokenFuture:
        def add_done_callback(self, callback: object) -> None:
            del callback
            raise RuntimeError("callback registration failed")

    scheduler = FrameSetScheduler(max_in_flight=1)
    failures: list[str] = []
    scheduler.replace_pending(
        [
            ScheduledFrame(
                fairness_key="Source",
                submit=BrokenFuture,
                completed=lambda _: None,
                submission_failed=lambda error: failures.append(str(error)),
            )
        ]
    )

    assert failures == ["callback registration failed"]
    assert scheduler.in_flight == 0
