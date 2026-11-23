import { aggregateUsage, type HarnessClient } from "../native-harness/src/client.ts";

export async function summarizeModelUsage(client: HarnessClient, channel?: string) {
  const attempts: Parameters<typeof aggregateUsage>[0][number][] = [];
  for (let after: string | undefined; ;) {
    const page = await client.modelCalls({ after });
    for (const call of page.calls) if (channel === undefined || call.channel === channel) attempts.push(...call.attempts);
    if (!page.next) break;
    after = page.next;
  }
  const totals = aggregateUsage(attempts);
  const missing = Object.fromEntries((["inputTokens", "outputTokens", "totalTokens"] as const)
    .map(field => [field, attempts.filter(attempt => attempt.usage?.[field] === undefined).length]));
  return { totals, missing, attempts: attempts.length, partial: Object.values(missing).some(count => count > 0) };
}
