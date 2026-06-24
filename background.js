const STORAGE_KEYS = {
  proxies: "proxies",
  activeProxyId: "activeProxyId",
  enabled: "enabled",
  activeProxySnapshot: "activeProxySnapshot"
};

const PROXY_STATE_KEYS = [
  STORAGE_KEYS.proxies,
  STORAGE_KEYS.activeProxyId,
  STORAGE_KEYS.enabled
];

const DEFAULT_PROXY_ID_PREFIX = "default:";
const CHECK_URL = "http://clients3.google.com/generate_204";
const CHECK_TIMEOUT_MS = 10000;
const PROXY_SETTINGS_SETTLE_MS = 250;

let activeCredentials = null;
let isCheckingProxies = false;

chrome.runtime.onInstalled.addListener(() => {
  applyProxyStateSafely("install");
});

chrome.runtime.onStartup.addListener(() => {
  applyProxyStateSafely("startup");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "APPLY_PROXY_STATE") {
    applyProxyState(message.proxy, { hasProxyFromMessage: Object.hasOwn(message, "proxy") })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message?.type === "CHECK_ALL_PROXIES") {
    checkAllProxies(message.proxies)
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  const shouldApply = Object.keys(changes).some((key) => PROXY_STATE_KEYS.includes(key));

  if (shouldApply) {
    applyProxyStateSafely("storage change");
  }
});

chrome.proxy.onProxyError.addListener((details) => {
  console.warn("Proxy error:", details.error, details.details || "");
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (!details.isProxy) {
      callback({});
      return;
    }

    getActiveCredentials()
      .then((credentials) => {
        if (!credentials) {
          callback({});
          return;
        }

        callback({
          authCredentials: {
            username: credentials.username,
            password: credentials.password
          }
        });
      })
      .catch((error) => {
        console.warn("Proxy credentials lookup failed:", error.message || error);
        callback({});
      });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

async function applyProxyState(proxyFromMessage = null, options = {}) {
  if (isCheckingProxies) {
    return;
  }

  try {
    const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    const activeProxy = options.hasProxyFromMessage
      ? normalizeProxy(proxyFromMessage)
      : await getStoredActiveProxy(data);

    if (!data.enabled || !activeProxy) {
      await disableProxy();
      return;
    }

    await setProxy(activeProxy);
    await cacheActiveProxy(activeProxy);
    await setBadge(true);
  } catch (error) {
    await disableProxy();
    throw error;
  }
}

async function applyProxyStateSafely(reason) {
  try {
    await applyProxyState();
  } catch (error) {
    console.warn(`Proxy state reset after ${reason}:`, error.message || error);
  }
}

async function disableProxy() {
  activeCredentials = null;
  await clearProxy();
  await setBadge(false);
}

async function getActiveCredentials() {
  if (activeCredentials) {
    return activeCredentials;
  }

  const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));

  if (!data.enabled) {
    return null;
  }

  const activeProxy = await getStoredActiveProxy(data);
  const credentials = getCredentialsForProxy(activeProxy);

  if (credentials) {
    activeCredentials = credentials;
  }

  return credentials;
}

async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
}

async function setBadge(isEnabled) {
  await chrome.action.setBadgeText({ text: isEnabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
}

async function checkAllProxies(proxiesFromMessage = null) {
  if (isCheckingProxies) {
    throw new Error("Proxy check is already running.");
  }

  isCheckingProxies = true;

  try {
    const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
    const hasMessageProxies = Array.isArray(proxiesFromMessage);
    const proxies = hasMessageProxies
      ? proxiesFromMessage.map(normalizeProxy).filter(Boolean)
      : Array.isArray(data.proxies) ? data.proxies.map(normalizeProxy).filter(Boolean) : [];
    const results = [];

    for (const proxy of proxies) {
      const result = await checkProxy(proxy);
      results.push(result);
    }

    if (!hasMessageProxies) {
      const resultById = new Map(results.map((result) => [result.id, result]));
      const updatedProxies = proxies.map((proxy) => ({
        ...proxy,
        check: resultToStoredCheck(resultById.get(proxy.id))
      }));

      await chrome.storage.local.set({ [STORAGE_KEYS.proxies]: updatedProxies });
    }

    return results;
  } finally {
    isCheckingProxies = false;
    await applyProxyStateSafely("proxy check");
  }
}

async function checkProxy(proxy) {
  const startedAt = Date.now();

  try {
    await setProxy(proxy);
    await wait(PROXY_SETTINGS_SETTLE_MS);
    await fetchWithTimeout(CHECK_URL, CHECK_TIMEOUT_MS);

    return {
      id: proxy.id,
      status: "online",
      latencyMs: Date.now() - startedAt,
      checkedAt: Date.now(),
      error: ""
    };
  } catch (error) {
    return {
      id: proxy.id,
      status: "offline",
      latencyMs: null,
      checkedAt: Date.now(),
      error: normalizeError(error)
    };
  }
}

async function setProxy(proxy) {
  activeCredentials = getCredentialsForProxy(proxy);

  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: proxy.scheme,
          host: proxy.host,
          port: proxy.port
        },
        bypassList: ["<local>"]
      }
    },
    scope: "regular"
  });
}

async function cacheActiveProxy(proxy) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.activeProxySnapshot]: sanitizeProxyForSnapshot(proxy)
  });
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}?t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function resultToStoredCheck(result) {
  return {
    status: result?.status === "online" ? "online" : "offline",
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
    checkedAt: Number.isFinite(result?.checkedAt) ? result.checkedAt : Date.now(),
    error: typeof result?.error === "string" ? result.error.slice(0, 80) : ""
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeError(error) {
  if (error?.name === "AbortError") {
    return "timeout";
  }

  return (error?.message || "failed").slice(0, 80);
}

function normalizeProxy(proxy) {
  if (!proxy) {
    return null;
  }

  return {
    ...proxy,
    scheme: proxy.scheme === "socks5" ? "socks5" : "http"
  };
}

function getCredentialsForProxy(proxy) {
  if (typeof proxy?.username !== "string" || typeof proxy?.password !== "string") {
    return null;
  }

  return {
    username: proxy.username,
    password: proxy.password
  };
}

function sanitizeProxyForSnapshot(proxy) {
  const normalizedProxy = normalizeProxy(proxy);

  if (!normalizedProxy) {
    return null;
  }

  return {
    id: normalizedProxy.id,
    raw: normalizedProxy.raw,
    scheme: normalizedProxy.scheme,
    host: normalizedProxy.host,
    port: normalizedProxy.port,
    username: normalizedProxy.username,
    password: normalizedProxy.password,
    createdAt: normalizedProxy.createdAt ?? null,
    isDefault: Boolean(normalizedProxy.isDefault)
  };
}

async function getStoredActiveProxy(data) {
  const proxies = Array.isArray(data.proxies) ? data.proxies : [];
  const storedProxy = normalizeProxy(proxies.find((proxy) => proxy.id === data.activeProxyId));

  if (storedProxy) {
    return storedProxy;
  }

  const snapshot = normalizeProxy(data.activeProxySnapshot);

  if (snapshot?.id === data.activeProxyId) {
    return snapshot;
  }

  const defaultProxyFromId = getDefaultProxyFromId(data.activeProxyId);

  if (defaultProxyFromId) {
    return defaultProxyFromId;
  }

  return null;
}

function getDefaultProxyFromId(id) {
  if (typeof id !== "string" || !id.startsWith(DEFAULT_PROXY_ID_PREFIX)) {
    return null;
  }

  const encodedRaw = id.slice(DEFAULT_PROXY_ID_PREFIX.length);
  const base64 = encodedRaw.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - base64.length % 4) % 4);

  try {
    const proxy = parseProxy(atob(base64 + padding));

    if (!proxy) {
      return null;
    }

    return {
      id,
      raw: proxy.raw,
      scheme: "http",
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      createdAt: null,
      isDefault: true
    };
  } catch (error) {
    return null;
  }
}

function parseProxy(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})@([^:@\s]+):([^@\s]+)$/);

  if (!match) {
    return null;
  }

  const host = match[1];
  const port = Number(match[2]);
  const username = match[3];
  const password = match[4];
  const octetsAreValid = host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);

  if (!octetsAreValid || port < 1 || port > 65535) {
    return null;
  }

  return { raw, host, port, username, password };
}
