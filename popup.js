const STORAGE_KEYS = {
  proxies: "proxies",
  activeProxyId: "activeProxyId",
  enabled: "enabled",
  defaultProxiesCache: "defaultProxiesCache",
  defaultProxyInfoCache: "defaultProxyInfoCache"
};

const DEFAULT_PROXY_LIST_URL = "https://webdev-master.github.io/proxylist.txt";
const REMOTE_MESSAGE_URL = "https://webdev-master.github.io/message.json";
const DEFAULT_PROXY_ID_PREFIX = "default:";
const DEFAULT_PROXY_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_PROXY_INFO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_MESSAGE_TAGS = new Set(["A", "B", "BR", "CODE", "EM", "I", "LI", "OL", "P", "S", "STRONG", "U", "UL"]);
const ALLOWED_MESSAGE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const ALLOWED_MESSAGE_COLORS = new Set(["green", "yellow", "red"]);
const COUNTRY_LOOKUP_PROVIDERS = [
  {
    url: (host) => `https://ipapi.co/${encodeURIComponent(host)}/json/`,
    parse: (data) => ({
      name: typeof data?.country_name === "string" ? data.country_name : "",
      code: typeof data?.country_code === "string" ? data.country_code.toUpperCase() : "",
      error: typeof data?.reason === "string" ? data.reason : ""
    })
  },
  {
    url: (host) => `https://ipwho.is/${encodeURIComponent(host)}`,
    parse: (data) => ({
      name: typeof data?.country === "string" ? data.country : "",
      code: typeof data?.country_code === "string" ? data.country_code.toUpperCase() : "",
      error: typeof data?.message === "string" ? data.message : ""
    })
  },
  {
    url: (host) => `http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,message,country,countryCode`,
    parse: (data) => ({
      name: typeof data?.country === "string" ? data.country : "",
      code: typeof data?.countryCode === "string" ? data.countryCode.toUpperCase() : "",
      error: typeof data?.message === "string" ? data.message : ""
    })
  }
];

const proxyForm = document.querySelector("#proxyForm");
const proxyInput = document.querySelector("#proxyInput");
const formMessage = document.querySelector("#formMessage");
const proxyList = document.querySelector("#proxyList");
const proxyCount = document.querySelector("#proxyCount");
const statusText = document.querySelector("#statusText");
const toggleProxy = document.querySelector("#toggleProxy");
const remoteMessage = document.querySelector("#remoteMessage");
const refreshDefaultProxies = document.querySelector("#refreshDefaultProxies");
const checkAllProxies = document.querySelector("#checkAllProxies");
const schemeInputs = Array.from(document.querySelectorAll("input[name='proxyScheme']"));
const countryLookupCache = new Map();

let state = {
  savedProxies: [],
  defaultProxies: [],
  defaultProxiesCachedAt: null,
  defaultProxyInfoCache: {},
  activeProxyId: null,
  enabled: false,
  isRefreshingDefaultProxies: false,
  isChecking: false
};

init();

async function init() {
  state = await loadState();
  render();
  loadRemoteMessage().catch((error) => {
    console.warn("Remote message could not be loaded:", error.message || error);
    hideRemoteMessage();
  });
  await loadDefaultProxies();
  if (reconcileActiveProxyState()) {
    await saveState();
  }
  render();
  await applyProxyState();
  loadCountriesForProxies().catch((error) => {
    setMessage(error.message || "Country lookup failed.", true);
  });
}

proxyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const parsed = parseProxy(proxyInput.value);

  if (!parsed) {
    setMessage("Enter a proxy in ip:port@username:password format.", true);
    return;
  }

  const exists = getAllProxies().some((proxy) => proxy.raw === parsed.raw);
  if (exists) {
    setMessage("This proxy is already in the list.", true);
    return;
  }

  const proxy = {
    id: crypto.randomUUID(),
    raw: parsed.raw,
    scheme: getSelectedScheme(),
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    password: parsed.password,
    createdAt: Date.now(),
    country: null
  };

  state.savedProxies = [proxy, ...state.savedProxies];
  state.activeProxyId = state.activeProxyId || proxy.id;
  await saveState();
  proxyInput.value = "";
  setMessage("Proxy added.");
  render();
  await applyProxyState();
  loadCountriesForProxies([proxy.id]).catch((error) => {
    setMessage(error.message || "Country lookup failed.", true);
  });
});

toggleProxy.addEventListener("click", async () => {
  const proxies = getAllProxies();

  if (!proxies.length) {
    setMessage("Add a proxy before enabling.", true);
    return;
  }

  if (!state.activeProxyId) {
    state.activeProxyId = proxies[0].id;
  }

  state.enabled = !state.enabled;
  await saveState();
  render();
  await applyProxyState();
});

refreshDefaultProxies.addEventListener("click", async () => {
  if (state.isRefreshingDefaultProxies) {
    return;
  }

  state.isRefreshingDefaultProxies = true;
  render();
  setMessage("Refreshing servers...");

  try {
    const refreshed = await loadDefaultProxies({ force: true });

    if (!refreshed) {
      return;
    }

    if (reconcileActiveProxyState()) {
      await saveState();
    }

    render();
    await applyProxyState();
    setMessage(`Server list refreshed. ${state.defaultProxies.length} loaded.`);
    loadCountriesForProxies().catch((error) => {
      setMessage(error.message || "Country lookup failed.", true);
    });
  } finally {
    state.isRefreshingDefaultProxies = false;
    render();
  }
});

checkAllProxies.addEventListener("click", async () => {
  const proxies = getAllProxies();

  if (!proxies.length || state.isChecking) {
    return;
  }

  state.isChecking = true;
  render();
  setMessage("Checking all proxies...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "CHECK_ALL_PROXIES",
      proxies
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Proxy check failed.");
    }

    applyCheckResults(response.results);
    await saveState();
    await saveDefaultProxyInfoCache();
    setMessage(`Checked ${response.results.length} proxies.`);
  } catch (error) {
    setMessage(error.message || "Proxy check failed.", true);
  } finally {
    state.isChecking = false;
    render();
  }
});

proxyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const { action, id } = button.dataset;

  if (action === "select") {
    state.activeProxyId = id;
    await saveState();
    render();
    await applyProxyState();
    return;
  }

  if (action === "delete") {
    const proxy = getAllProxies().find((item) => item.id === id);

    if (proxy?.isDefault) {
      setMessage("Default proxies cannot be deleted.", true);
      return;
    }

    state.savedProxies = state.savedProxies.filter((item) => item.id !== id);

    if (state.activeProxyId === id) {
      const proxies = getAllProxies();
      state.activeProxyId = proxies[0]?.id || null;
      state.enabled = proxies.length ? state.enabled : false;
    }

    await saveState();
    render();
    await applyProxyState();
  }
});

async function loadState() {
  const data = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  const savedProxies = normalizeProxies(data.proxies).filter((proxy) => !proxy.isDefault);
  const defaultProxyInfoCache = normalizeDefaultProxyInfoCache(data.defaultProxyInfoCache);
  const defaultProxiesCache = normalizeDefaultProxiesCache(data.defaultProxiesCache, defaultProxyInfoCache, savedProxies);

  return {
    savedProxies,
    defaultProxies: defaultProxiesCache.proxies,
    defaultProxiesCachedAt: defaultProxiesCache.cachedAt,
    defaultProxyInfoCache,
    activeProxyId: data.activeProxyId || null,
    enabled: Boolean(data.enabled)
  };
}

async function saveState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.proxies]: state.savedProxies,
    [STORAGE_KEYS.activeProxyId]: state.activeProxyId,
    [STORAGE_KEYS.enabled]: state.enabled
  });
}

async function applyProxyState() {
  await chrome.runtime.sendMessage({
    type: "APPLY_PROXY_STATE",
    proxy: getActiveProxy()
  });
}

async function loadRemoteMessage() {
  const response = await fetch(REMOTE_MESSAGE_URL, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const message = typeof data?.message === "string" ? data.message.trim() : "";
  const color = normalizeRemoteMessageColor(data?.color);

  if (!message) {
    hideRemoteMessage();
    return;
  }

  showRemoteMessage(message, color);
}

function showRemoteMessage(message, color) {
  const safeHtml = sanitizeMessageHtml(message);

  if (!safeHtml) {
    hideRemoteMessage();
    return;
  }

  remoteMessage.innerHTML = safeHtml;
  remoteMessage.classList.remove("is-green", "is-yellow", "is-red");
  remoteMessage.classList.add(`is-${color}`);
  remoteMessage.hidden = false;
}

function hideRemoteMessage() {
  remoteMessage.innerHTML = "";
  remoteMessage.classList.remove("is-green", "is-yellow", "is-red");
  remoteMessage.hidden = true;
}

function normalizeRemoteMessageColor(value) {
  return ALLOWED_MESSAGE_COLORS.has(value) ? value : "green";
}

function sanitizeMessageHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value);
  sanitizeMessageNode(template.content);
  return template.innerHTML.trim();
}

function sanitizeMessageNode(parent) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      continue;
    }

    const tagName = node.tagName;

    if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED"].includes(tagName)) {
      node.remove();
      continue;
    }

    sanitizeMessageNode(node);

    if (!ALLOWED_MESSAGE_TAGS.has(tagName)) {
      node.replaceWith(...Array.from(node.childNodes));
      continue;
    }

    sanitizeMessageAttributes(node);
  }
}

function sanitizeMessageAttributes(element) {
  const href = element.tagName === "A" ? element.getAttribute("href") : "";

  for (const attribute of Array.from(element.attributes)) {
    element.removeAttribute(attribute.name);
  }

  if (element.tagName !== "A") {
    return;
  }

  const safeHref = getSafeMessageHref(href);

  if (!safeHref) {
    return;
  }

  element.setAttribute("href", safeHref);
  element.setAttribute("target", "_blank");
  element.setAttribute("rel", "noopener noreferrer");
}

function getSafeMessageHref(value) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value, window.location.href);
    return ALLOWED_MESSAGE_LINK_PROTOCOLS.has(url.protocol) ? url.href : "";
  } catch (error) {
    return "";
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

function getSelectedScheme() {
  return schemeInputs.find((input) => input.checked)?.value || "http";
}

function normalizeProxies(proxies) {
  if (!Array.isArray(proxies)) {
    return [];
  }

  return proxies.map((proxy) => ({
    ...proxy,
    scheme: proxy.scheme === "socks5" ? "socks5" : "http",
    check: normalizeCheck(proxy.check),
    country: normalizeCountry(proxy.country)
  }));
}

async function loadDefaultProxies(options = {}) {
  if (!options.force && isDefaultProxiesCacheFresh()) {
    return true;
  }

  try {
    const response = await fetch(DEFAULT_PROXY_LIST_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    const fetchedDefaultProxies = buildDefaultProxyList(parseDefaultProxyListText(text));

    if (!areDefaultProxyListsEqual(state.defaultProxies, fetchedDefaultProxies)) {
      state.defaultProxies = fetchedDefaultProxies;
    }

    state.defaultProxiesCachedAt = Date.now();
    await saveDefaultProxiesCache();
    return true;
  } catch (error) {
    setMessage(`Default proxy list could not be refreshed: ${error.message}`, true);
    return false;
  }
}

function parseDefaultProxyListText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => parseProxy(line))
    .filter(Boolean);
}

function buildDefaultProxyList(parsedProxies, infoCache = state.defaultProxyInfoCache, savedProxies = state.savedProxies) {
  const savedRawValues = new Set(savedProxies.map((proxy) => proxy.raw));
  const seenRawValues = new Set();

  return parsedProxies
    .filter((proxy) => {
      if (savedRawValues.has(proxy.raw) || seenRawValues.has(proxy.raw)) {
        return false;
      }

      seenRawValues.add(proxy.raw);
      return true;
    })
    .map((proxy) => createDefaultProxy(proxy, infoCache));
}

function createDefaultProxy(proxy, infoCache = state.defaultProxyInfoCache) {
  const id = getDefaultProxyId(proxy.raw);

  return {
    id,
    raw: proxy.raw,
    scheme: "http",
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    createdAt: null,
    isDefault: true,
    ...getCachedDefaultProxyInfo(id, infoCache)
  };
}

function normalizeDefaultProxiesCache(cache, infoCache, savedProxies) {
  const proxies = Array.isArray(cache?.proxies) ? cache.proxies : [];
  const cachedAt = Number(cache?.cachedAt);

  return {
    proxies: buildDefaultProxyList(
      proxies
        .map((proxy) => parseProxy(proxy?.raw))
        .filter(Boolean),
      infoCache,
      savedProxies
    ),
    cachedAt: Number.isFinite(cachedAt) ? cachedAt : null
  };
}

function areDefaultProxyListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((proxy, index) => proxy.raw === right[index].raw);
}

async function saveDefaultProxiesCache() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.defaultProxiesCache]: {
      cachedAt: state.defaultProxiesCachedAt,
      proxies: state.defaultProxies.map(sanitizeDefaultProxyForCache)
    }
  });
}

function isDefaultProxiesCacheFresh() {
  return Number.isFinite(state.defaultProxiesCachedAt)
    && Date.now() - state.defaultProxiesCachedAt < DEFAULT_PROXY_CACHE_TTL_MS;
}

function sanitizeDefaultProxyForCache(proxy) {
  return {
    raw: proxy.raw
  };
}

function getDefaultProxyId(raw) {
  return `${DEFAULT_PROXY_ID_PREFIX}${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function getAllProxies() {
  return [...state.defaultProxies, ...state.savedProxies];
}

function getActiveProxy() {
  return getAllProxies().find((proxy) => proxy.id === state.activeProxyId) || null;
}

function reconcileActiveProxyState() {
  const proxies = getAllProxies();

  if (!proxies.length) {
    const changed = Boolean(state.activeProxyId || state.enabled);
    state.activeProxyId = null;
    state.enabled = false;
    return changed;
  }

  if (!state.activeProxyId) {
    const changed = Boolean(state.enabled);
    state.enabled = false;
    return changed;
  }

  if (proxies.some((proxy) => proxy.id === state.activeProxyId)) {
    return false;
  }

  state.activeProxyId = proxies[0].id;
  state.enabled = false;
  return true;
}

function applyCheckResults(results) {
  const resultById = new Map(results.map((result) => [result.id, result]));
  const applyResult = (proxy) => ({
    ...proxy,
    check: resultById.has(proxy.id) ? resultToCheck(resultById.get(proxy.id)) : proxy.check
  });

  state.defaultProxies = state.defaultProxies.map(applyResult);
  state.savedProxies = state.savedProxies.map(applyResult);
  updateDefaultProxyCheckCache(resultById);
}

function resultToCheck(result) {
  return {
    status: result?.status === "online" ? "online" : "offline",
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
    checkedAt: Number.isFinite(result?.checkedAt) ? result.checkedAt : Date.now(),
    error: typeof result?.error === "string" ? result.error.slice(0, 80) : ""
  };
}

async function loadCountriesForProxies(proxyIds = null) {
  const idFilter = Array.isArray(proxyIds) ? new Set(proxyIds) : null;
  const targets = getAllProxies().filter((proxy) => {
    if (idFilter && !idFilter.has(proxy.id)) {
      return false;
    }

    return shouldLoadCountry(proxy.country);
  });

  if (!targets.length) {
    return;
  }

  for (const proxy of targets) {
    setCountryForHost(proxy.host, {
      status: "loading",
      name: "",
      code: "",
      error: ""
    });
  }

  render();

  const hosts = [...new Set(targets.map((proxy) => proxy.host))];

  for (const host of hosts) {
    const country = countryLookupCache.get(host) || await fetchCountry(host);
    countryLookupCache.set(host, country);
    const savedChanged = setCountryForHost(host, country);
    render();

    if (savedChanged) {
      await saveState();
    }

    await saveDefaultProxyInfoCache();
  }
}

async function fetchCountry(host) {
  const errors = [];

  for (const provider of COUNTRY_LOOKUP_PROVIDERS) {
    const country = await fetchCountryFromProvider(host, provider);

    if (country.status === "loaded") {
      return country;
    }

    if (country.error) {
      errors.push(country.error);
    }
  }

  return {
    status: "error",
    name: "",
    code: "",
    error: errors.find(Boolean) || "country not found"
  };
}

async function fetchCountryFromProvider(host, provider) {
  try {
    const response = await fetch(provider.url(host), {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const parsed = provider.parse(data);
    const name = parsed.name;
    const code = parsed.code;

    if (!name && !code) {
      throw new Error(parsed.error || "country not found");
    }

    return {
      status: "loaded",
      name,
      code,
      error: ""
    };
  } catch (error) {
    return {
      status: "error",
      name: "",
      code: "",
      error: normalizeCountryError(error)
    };
  }
}

function shouldLoadCountry(country) {
  return !country || (country.status !== "loaded" && country.status !== "loading");
}

function setCountryForHost(host, country) {
  const applyCountry = (proxy) => proxy.host === host ? { ...proxy, country } : proxy;
  const savedChanged = state.savedProxies.some((proxy) => proxy.host === host);

  state.defaultProxies = state.defaultProxies.map(applyCountry);
  state.savedProxies = state.savedProxies.map(applyCountry);
  updateDefaultProxyCountryCache(host, country);

  return savedChanged;
}

function getCachedDefaultProxyInfo(id, infoCache = state.defaultProxyInfoCache) {
  const cached = infoCache[id] || {};

  return {
    check: cached.check || null,
    country: cached.country || null
  };
}

function updateDefaultProxyCountryCache(host, country) {
  if (country?.status !== "loaded") {
    return;
  }

  const now = Date.now();

  for (const proxy of state.defaultProxies.filter((item) => item.host === host)) {
    const current = state.defaultProxyInfoCache[proxy.id] || {};
    state.defaultProxyInfoCache[proxy.id] = {
      ...current,
      country,
      countryCachedAt: now
    };
  }

  state.defaultProxyInfoCache = pruneDefaultProxyInfoCache(state.defaultProxyInfoCache);
}

function updateDefaultProxyCheckCache(resultById) {
  const now = Date.now();

  for (const proxy of state.defaultProxies) {
    if (!resultById.has(proxy.id) || !proxy.check) {
      continue;
    }

    const current = state.defaultProxyInfoCache[proxy.id] || {};
    state.defaultProxyInfoCache[proxy.id] = {
      ...current,
      check: proxy.check,
      checkCachedAt: now
    };
  }

  state.defaultProxyInfoCache = pruneDefaultProxyInfoCache(state.defaultProxyInfoCache);
}

async function saveDefaultProxyInfoCache() {
  state.defaultProxyInfoCache = pruneDefaultProxyInfoCache(state.defaultProxyInfoCache);
  await chrome.storage.local.set({
    [STORAGE_KEYS.defaultProxyInfoCache]: state.defaultProxyInfoCache
  });
}

function normalizeDefaultProxyInfoCache(cache) {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) {
    return {};
  }

  return pruneDefaultProxyInfoCache(cache);
}

function pruneDefaultProxyInfoCache(cache) {
  const now = Date.now();
  const normalized = {};

  for (const [id, info] of Object.entries(cache)) {
    if (!id.startsWith(DEFAULT_PROXY_ID_PREFIX) || !info || typeof info !== "object") {
      continue;
    }

    const entry = {};
    const countryCachedAt = Number(info.countryCachedAt);
    const checkCachedAt = Number(info.checkCachedAt);

    if (now - countryCachedAt <= DEFAULT_PROXY_INFO_CACHE_TTL_MS) {
      const country = normalizeCountry(info.country);

      if (country?.status === "loaded") {
        entry.country = country;
        entry.countryCachedAt = countryCachedAt;
      }
    }

    if (now - checkCachedAt <= DEFAULT_PROXY_INFO_CACHE_TTL_MS) {
      const check = normalizeCheck(info.check);

      if (check) {
        entry.check = check;
        entry.checkCachedAt = checkCachedAt;
      }
    }

    if (entry.country || entry.check) {
      normalized[id] = entry;
    }
  }

  return normalized;
}

function normalizeCountry(country) {
  if (!country || typeof country !== "object") {
    return null;
  }

  const status = ["loaded", "loading", "error"].includes(country.status) ? country.status : "error";

  return {
    status,
    name: typeof country.name === "string" ? country.name : "",
    code: typeof country.code === "string" ? country.code : "",
    error: typeof country.error === "string" ? country.error : ""
  };
}

function normalizeCountryError(error) {
  return (error?.message || "failed").slice(0, 80);
}

function normalizeCheck(check) {
  if (!check || typeof check !== "object") {
    return null;
  }

  return {
    status: check.status === "online" ? "online" : "offline",
    latencyMs: Number.isFinite(check.latencyMs) ? check.latencyMs : null,
    checkedAt: Number.isFinite(check.checkedAt) ? check.checkedAt : null,
    error: typeof check.error === "string" ? check.error : ""
  };
}

function render() {
  const proxies = getAllProxies();
  const activeProxy = getActiveProxy();
  const isEnabled = Boolean(state.enabled && activeProxy);

  statusText.textContent = isEnabled ? `${activeProxy.scheme.toUpperCase()} ${activeProxy.host}:${activeProxy.port}` : "Proxy is off";
  toggleProxy.classList.toggle("is-on", isEnabled);
  toggleProxy.setAttribute("aria-checked", String(isEnabled));
  toggleProxy.setAttribute("aria-label", isEnabled ? "Disable proxy" : "Enable proxy");
  proxyCount.textContent = String(proxies.length);
  refreshDefaultProxies.disabled = state.isRefreshingDefaultProxies;
  refreshDefaultProxies.textContent = state.isRefreshingDefaultProxies ? "Refreshing..." : "Refresh";
  checkAllProxies.disabled = !proxies.length || state.isChecking || state.isRefreshingDefaultProxies;
  checkAllProxies.textContent = state.isChecking ? "Checking..." : "Check all";

  if (!proxies.length) {
    proxyList.innerHTML = `<div class="empty">The list is empty. Add a proxy to enable the connection.</div>`;
    return;
  }

  proxyList.innerHTML = proxies.map((proxy) => renderProxy(proxy, proxy.id === state.activeProxyId)).join("");
}

function renderProxy(proxy, isActive) {
  const safeHost = escapeHtml(`${proxy.host}:${proxy.port}`);
  const safeUser = escapeHtml(proxy.username);
  const safeScheme = escapeHtml(proxy.scheme.toUpperCase());
  const activeText = isActive ? "Active" : "Not selected";
  const selectTitle = isActive ? "Selected proxy" : "Select proxy";
  const defaultBadge = proxy.isDefault ? `<span class="proxy-badge">Default</span>` : "";
  const deleteTitle = proxy.isDefault ? "Default proxies cannot be deleted" : "Delete proxy";
  const country = getCountryView(proxy.country);
  const check = getCheckView(proxy.check);

  return `
    <article class="proxy-item ${isActive ? "is-active" : ""} ${proxy.isDefault ? "is-default" : ""}">
      <div class="proxy-main">
        <div class="proxy-host">${safeHost}</div>
        <div class="proxy-meta">
          <span class="dot"></span>
          <span>${safeScheme}</span>
          ${defaultBadge}
          <span class="country ${country.className}" title="${country.title}">${country.label}</span>
          <span>${safeUser}</span>
          <span>${activeText}</span>
        </div>
        <div class="check ${check.className}">
          <span class="check__dot"></span>
          <span>${check.label}</span>
        </div>
      </div>
      <div class="actions">
        <button class="icon-btn" type="button" data-action="select" data-id="${proxy.id}" title="${selectTitle}" aria-label="${selectTitle}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
        </button>
        <button class="icon-btn is-danger" type="button" data-action="delete" data-id="${proxy.id}" title="${deleteTitle}" aria-label="${deleteTitle}" ${proxy.isDefault ? "disabled" : ""}>
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="M19 6l-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    </article>
  `;
}

function getCountryView(country) {
  if (!country || country.status === "loading") {
    return {
      className: "is-loading",
      label: "Country...",
      title: "Country lookup is in progress"
    };
  }

  if (country.status === "loaded") {
    const label = country.code || country.name;
    const title = country.name && country.code ? `${country.name} (${country.code})` : country.name || country.code;

    return {
      className: "",
      label: escapeHtml(label),
      title: escapeHtml(title)
    };
  }

  return {
    className: "is-unknown",
    label: "Unknown country",
    title: escapeHtml(country.error || "Country could not be detected")
  };
}

function getCheckView(check) {
  if (!check) {
    return {
      className: "is-unknown",
      label: "Not checked"
    };
  }

  if (check.status === "online") {
    const latency = Number.isFinite(check.latencyMs) ? ` - ${check.latencyMs} ms` : "";
    const checkedAt = formatCheckedAt(check.checkedAt);
    return {
      className: "is-online",
      label: `Online${latency}${checkedAt}`
    };
  }

  const checkedAt = formatCheckedAt(check.checkedAt);
  return {
    className: "is-offline",
    label: check.error ? `Offline - ${escapeHtml(check.error)}${checkedAt}` : `Offline${checkedAt}`
  };
}

function formatCheckedAt(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return ` - ${new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function setMessage(message, isError = false) {
  formMessage.textContent = message;
  formMessage.classList.toggle("is-error", isError);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });
}
