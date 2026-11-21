# Finding: metering and a turn's last presentation write have no defined order

Status: recorded 2026-11-13, during A2 of the controller-interface spec; accepted as today's behaviour.

## What happens

At the end of a turn, two writes race:

- **managed mode:** the metering event and the turn's presentation events; presentation events are delivered from
  their own queue and may lag, so metering has been seen before the in-progress presentation as well as between the
  in-progress and completed ones (2026-11-13);
- **Agent-owned mode:** the metering record and the turn's last in-progress assistant snapshot record (the snapshot
  goes through the serialized `ownerRecordWrite` chain, while `ownerLifecycle.meteringRecorded` writes directly).

Both orders occur on A1 (before any refactor). Their relative order is not part of the contract
(`../11-11-SPEC-controller-interface.md`, Which orders are contractual); tests accept either order for these two
pairs only.

## If a consumer ever needs one total order

Serialize the two writes so every observer sees one order. That is a behaviour change, with questions to settle
first: what happens to metering if the earlier write fails (wait, fail the turn, or record anyway), and the effect on
record sequence numbers and latency in all persistence modes.
