(function () {
  try {
    var mode = localStorage.getItem('dumate.admin.theme') || 'auto'
    var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
    if (dark) {
      document.documentElement.classList.add('dark')
      document.documentElement.style.colorScheme = 'dark'
      var meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', '#0b111c')
    } else {
      document.documentElement.style.colorScheme = 'light'
    }
  } catch (e) {
    // Keep the default theme if localStorage is unavailable.
  }
})()
