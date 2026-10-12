// POSITIVE FIXTURE — must pass the kernel-purity gate. Not part of any build.
export function assertTenantContext(ctx: { tenantId?: string }): asserts ctx is { tenantId: string } {
  if (!ctx.tenantId) throw new Error("tenant context missing");
}
