const sitePreference = document.documentElement.getAttribute("data-default-appearance");
const userPreference = localStorage.getItem("appearance");

function getCSSValue(varName) {
  var cssValue = window.getComputedStyle(document.documentElement).getPropertyValue(varName);
  return "rgb(" + cssValue.replace(/\s+/g, "") + ")";
}

function setThemeColor() {
  var metaThemeColor = document.querySelector("meta[name=theme-color]");
  document.documentElement.classList.contains("dark")
    ? metaThemeColor.setAttribute("content", getCSSValue("--color-neutral-800"))
    : metaThemeColor.setAttribute("content", getCSSValue("--color-neutral"));
  return true;
}

if ((sitePreference === "dark" && userPreference === null) || userPreference === "dark") {
  document.documentElement.classList.add("dark");
  setThemeColor();
}

if (document.documentElement.getAttribute("data-auto-appearance") === "true") {
  if (
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches &&
    userPreference !== "light"
  ) {
    document.documentElement.classList.add("dark");
    setThemeColor();
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (event.matches) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    setThemeColor();
  });
}

function setGiscusTheme(theme) {
  function sendMessage(message) {
    let iframe = document.querySelector('iframe.giscus-frame');
    iframe.contentWindow.postMessage({ giscus: message }, 'https://giscus.app');
  }

  sendMessage({
    setConfig: {
      theme: theme
    }
  });
}

function setGiscusThemeOnLoad() {
  const theme = userPreference != null ? userPreference : sitePreference;
  const interval = setInterval(() => {
    const iframe = document.querySelector('iframe.giscus-frame');
    const loaded = !iframe.classList.contains('giscus-frame--loading');
    if (loaded) {
      setGiscusTheme(theme === "dark" ? "dark_dimmed" : "light")
      clearInterval(interval);
    }
  }, 1500)
}

window.addEventListener("DOMContentLoaded", (event) => {
  setGiscusThemeOnLoad();
  var switchers = document.querySelectorAll("[id^='appearance-switcher']");
  switchers.forEach((switcher) => {
    switcher.addEventListener("click", () => {
      document.documentElement.classList.toggle("dark");
      setThemeColor();
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      setGiscusTheme(theme === "dark" ? "dark_dimmed" : "light")
      localStorage.setItem(
        "appearance",
        theme
      );
    });
    switcher.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      localStorage.removeItem("appearance");
    });
  });
});