# 0043. Managed native inspector

The existing inspector is useful when a host launches the harness over
stdio. Enable it through trusted launch environment only, with loopback
as the default bind and port 0 available for automatic allocation.
Wildcard binding requires an explicit allowed loopback Host authority.
The launcher owns the published browser URL and network isolation.

Report the optional process-local inspector status through executable
create, open, and status. A configuration or bind failure leaves the
session usable. Omit the field when disabled so existing clients retain
their current behavior. Close the listener before successful stop returns
and remove capture resources on endpoint teardown.

Reuse the existing inspector UI and bounded observations. Keep runtime
credentials and inline attachment bytes outside retained captures. No
portable config, archive, or database format changes.

See the [amendment](../docs/operator-controls/0002-AMENDMENT-managed-inspector/SPEC.md).
