function execLocal(value: string): void {
  void value;
}

function forbiddenCallback(value: string): void {
  execLocal(value);
}

export function authorizationCallbackFixture(items: string[]): void {
  switch ('fixture.callback') {
    case 'fixture.callback':
      items.forEach(forbiddenCallback);
  }
}
