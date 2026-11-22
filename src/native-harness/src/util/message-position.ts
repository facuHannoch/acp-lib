export function messagePosition(sessionId: string, channelId: string, seq: number): string {
  return Buffer.from(JSON.stringify([sessionId, channelId, seq])).toString("base64url");
}
