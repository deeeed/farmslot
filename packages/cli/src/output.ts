export class OutputContext {
  readonly json: boolean;

  constructor(json: boolean) {
    this.json = json;
  }

  writeJson(data: unknown): void {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }

  write(text: string): void {
    process.stdout.write(text);
  }

  error(msg: string): void {
    process.stderr.write(`Error: ${msg}\n`);
  }
}
