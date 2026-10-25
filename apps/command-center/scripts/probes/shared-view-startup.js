() => {
  const all = (root) =>
    Array.from(root.querySelectorAll('*')).flatMap((element) => [
      element,
      ...(element.shadowRoot ? all(element.shadowRoot) : []),
    ]);
  const nodes = all(document);
  return {
    href: location.href,
    text: document.body.innerText,
    mountedShell: nodes.some((element) => element.localName === 'app-shell'),
    mountedRun: nodes.some((element) => element.localName === 'run-detail' && element.run?.id),
    passwordFields: nodes.filter((element) => element.matches('input[type=password]')).length,
    modules: performance
      .getEntriesByType('resource')
      .map((entry) => new URL(entry.name).pathname)
      .filter((name) => name.includes('/src/')),
  };
};
