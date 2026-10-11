// Close a Playwright context without a stray failure: a route handler whose fetch
// is still in flight when the context closes rejects, and node:test reports that
// unhandled rejection against whichever test is running (a flaky red run).
// Unrouting first (ignoring those errors) lets in-flight handlers die quietly.

export async function closeQuietly(ctx: any): Promise<void> {
  await Promise.all([ctx, ...ctx.pages()].map((x: any) => x.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {})));
  await ctx.close();
}
