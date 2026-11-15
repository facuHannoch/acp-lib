# Explicit notice representation

Context entries and accepted turn inputs distinguish participant messages from
channel notices, recording a notice's source channel. Both idle and busy delivery
use the same entry shape; idle notices no longer pass through participant-message
formatting. A context renderer presents notices as user-role internal inputs from
another execution of the same agent. Provider roles and tool exchanges are unchanged.

The inspector uses typed notice entries to highlight their rendered messages in
violet, independently of the initiating participant prompt. Existing in-memory
data without kind metadata remains readable; new inputs always carry a kind.
No persisted data or public protocol migration is required.
