let cached: string | null = null;
let loaded: Promise<void> | null = null;

export async function getBasePath(): Promise<string> {
  if (cached !== null) return cached;
  if (!loaded) {
    loaded = fetch('./config.json')
      .then(r => r.json())
      .then((cfg: { basePath: string }) => {
        cached = (cfg.basePath ?? '/').replace(/\/$/, '') || '/';
      })
      .catch(() => {
        cached = '/';
      })
      .finally(() => {
        loaded = null;
      });
  }
  await loaded;
  return cached!;
}

export function getBasePathSync(): string | null {
  return cached;
}
