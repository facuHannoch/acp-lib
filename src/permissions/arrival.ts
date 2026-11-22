import type { PermissionRequest } from "../types.ts";

export function permissionArrival() {
  return { wallTime: Date.now(), monotonicTime: performance.now() };
}
export type PermissionArrival = ReturnType<typeof permissionArrival>;

export const acpPermissionArrivals = new WeakMap<PermissionRequest, PermissionArrival>();

export function stampAcpPermission(request: PermissionRequest): PermissionRequest {
  acpPermissionArrivals.set(request, permissionArrival());
  return request;
}
