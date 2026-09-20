export interface FakeKv {
  kv: KVNamespace;
  store: Map<string, string>;
  state: { puts: number };
}

export function createFakeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map<string, string>(Object.entries(initial));
  const state = { puts: 0 };

  const kv = {
    async get(key: string, type?: string) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      state.puts += 1;
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;

  return { kv, store, state };
}

export interface FetchMock {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit | undefined; thisArg: unknown }[];
}

export function createFetchMock(
  handler: (
    url: string,
    init: RequestInit | undefined,
    callIndex: number,
  ) => Response,
): FetchMock {
  const calls: { url: string; init: RequestInit | undefined; thisArg: unknown }[] = [];

  // A non-arrow function so tests can assert the `this` binding (Workers'
  // `fetch` rejects being called as a method with an "Illegal invocation").
  const fetchImpl = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const response = handler(url, init, calls.length);
    calls.push({ url, init, thisArg: this });
    return response as unknown as Response;
  } as unknown as typeof fetch;

  return { fetchImpl, calls };
}

export function jsonResponse(body: unknown, headers: Record<string, string> = {}, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
