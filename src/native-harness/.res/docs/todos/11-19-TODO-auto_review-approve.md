# TODO: Automatic tool approval review

Status: deferred. Revisit after consumer approval works end to end.

Add an optional automatic reviewer behind the tool approval interface. The
policy gate resolves each call to allow, deny, or ask. An ask can go to an
automatic reviewer or the consumer. A policy denial is final.

The reviewer judges whether the exact call is authorized and within scope.
Give it the tool name and arguments, the relevant user request, the channel
and turn, and the rule that triggered review. Provide more context only when
needed. Treat conversation text and tool output as evidence.

The reviewer can approve the exact call once, deny with a reason, or escalate
to the consumer. If nobody can answer an escalation, leave the tool unexecuted.
Record the outcome and reason against the original approval request.

Use the same request lifecycle as consumer approval. On suspension, close the
request and record why the tool did not run. A resumed turn can request fresh
approval if the action is still needed. Ignore late responses to closed
requests.

Before implementing, decide how consumers opt in, what context the reviewer may
access, and which actions always require human approval.
