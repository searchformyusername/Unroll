import { parse } from "./parse";
self.onmessage = async (event: MessageEvent<{ text: string }>) => {
  try {
    const result = parse(event.data.text);
    let fingerprint: string | undefined;
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(event.data.text),
      );
      fingerprint = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }
    self.postMessage({ result: { ...result, fingerprint } });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "This trajectory could not be parsed.",
    });
  }
};
