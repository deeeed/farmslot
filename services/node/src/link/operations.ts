import path from 'node:path';

import {
  isNodeLinkCommand,
  NODE_LINK_LIMITS,
  type NodeFsPathParams,
  NodeLinkFailure,
  type NodeLinkProcessInput,
  type NodeLinkTerminalSize,
  type TypedNodeLinkCommand,
} from '@farmslot/protocol';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(message: string): never {
  throw new NodeLinkFailure('INVALID_PARAMS', message);
}
const integer = (value: unknown, maximum: number, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

export { NODE_LINK_OPERATIONS } from '@farmslot/protocol';

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid('Unexpected operation field.');
}

function filePath(value: Record<string, unknown>): NodeFsPathParams {
  if (
    typeof value.root !== 'string' ||
    !path.isAbsolute(value.root) ||
    typeof value.relPath !== 'string' ||
    path.isAbsolute(value.relPath) ||
    value.relPath.includes('\\') ||
    value.relPath.includes('\0') ||
    value.root.includes('\0') ||
    value.relPath.split('/').some((part) => part === '..' || part === '.git')
  )
    invalid('Files require an admitted absolute root and confined relative path.');
  return { root: value.root, relPath: value.relPath };
}

function expectedHash(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    invalid('Invalid file hash precondition.');
  return value;
}

function base64(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) ||
    Buffer.from(value, 'base64').byteLength > NODE_LINK_LIMITS.chunkBytes ||
    Buffer.from(value, 'base64').toString('base64') !== value
  )
    invalid('File payload must be canonical base64 within the chunk limit.');
  return value;
}

export function parseNodeLinkTerminalSize(value: unknown): NodeLinkTerminalSize {
  if (!object(value)) invalid('Invalid terminal dimensions.');
  fields(value, ['cols', 'rows']);
  if (!integer(value.cols, 1000, 1) || !integer(value.rows, 1000, 1))
    invalid('Invalid terminal dimensions.');
  return { cols: value.cols, rows: value.rows };
}

export function parseNodeLinkProcess(value: unknown): NodeLinkProcessInput {
  if (!object(value)) invalid('Invalid process input.');
  fields(value, [
    'argv',
    'cwd',
    'timeoutMs',
    'closeoutTimeoutMs',
    'maxOutputBytes',
    'environment',
    'terminal',
  ]);
  if (
    !Array.isArray(value.argv) ||
    value.argv.length < 1 ||
    value.argv.length > 1024 ||
    !value.argv.every((arg): arg is string => typeof arg === 'string' && !arg.includes('\0')) ||
    typeof value.cwd !== 'string' ||
    !path.isAbsolute(value.cwd) ||
    value.cwd.includes('\0') ||
    !integer(value.timeoutMs, 24 * 60 * 60 * 1000, 1) ||
    !integer(value.maxOutputBytes, 32 * 1024 * 1024, 1) ||
    (value.closeoutTimeoutMs !== undefined && !integer(value.closeoutTimeoutMs, 60_000, 1)) ||
    (value.environment !== undefined &&
      value.environment !== 'service' &&
      value.environment !== 'login')
  )
    invalid('Process argv, cwd or limits are invalid.');
  return {
    argv: value.argv,
    cwd: value.cwd,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes,
    ...(typeof value.closeoutTimeoutMs === 'number'
      ? { closeoutTimeoutMs: value.closeoutTimeoutMs }
      : {}),
    ...(value.environment === 'login' || value.environment === 'service'
      ? { environment: value.environment }
      : {}),
    ...(value.terminal !== undefined
      ? { terminal: parseNodeLinkTerminalSize(value.terminal) }
      : {}),
  };
}

export function parseNodeLinkOperation(value: unknown): TypedNodeLinkCommand {
  if (!isNodeLinkCommand(value) || !object(value.input)) invalid('Invalid typed command.');
  const input = value.input;
  switch (value.operation) {
    case 'system.which': {
      fields(input, ['programs']);
      if (
        !Array.isArray(input.programs) ||
        input.programs.length > 32 ||
        !input.programs.every(
          (program): program is string =>
            typeof program === 'string' && /^[A-Za-z0-9._+-]{1,128}$/.test(program),
        )
      )
        invalid('Binary inventory requires bounded program names.');
      return { ...value, operation: value.operation, input: { programs: input.programs } };
    }
    case 'file.exists':
    case 'file.inspect':
    case 'file.read':
    case 'file.hash':
    case 'file.mkdir':
      fields(input, ['root', 'relPath']);
      return { ...value, operation: value.operation, input: filePath(input) };
    case 'file.read-range': {
      fields(input, ['root', 'relPath', 'offset', 'length']);
      if (
        !integer(input.offset, Number.MAX_SAFE_INTEGER) ||
        !integer(input.length, NODE_LINK_LIMITS.chunkBytes, 1)
      )
        invalid('Invalid read range.');
      return {
        ...value,
        operation: value.operation,
        input: { ...filePath(input), offset: input.offset, length: input.length },
      };
    }
    case 'file.write': {
      fields(input, ['root', 'relPath', 'content', 'expectedHash']);
      if (
        typeof input.content !== 'string' ||
        Buffer.byteLength(input.content) > NODE_LINK_LIMITS.chunkBytes
      )
        invalid('Write requires bounded text.');
      return {
        ...value,
        operation: value.operation,
        input: {
          ...filePath(input),
          content: input.content,
          ...(input.expectedHash !== undefined
            ? { expectedHash: expectedHash(input.expectedHash) }
            : {}),
        },
      };
    }
    case 'file.write-range': {
      fields(input, ['root', 'relPath', 'offset', 'content', 'truncate', 'mode']);
      if (
        !integer(input.offset, Number.MAX_SAFE_INTEGER) ||
        (input.truncate !== undefined && typeof input.truncate !== 'boolean') ||
        (input.mode !== undefined && !integer(input.mode, 0o777))
      )
        invalid('Invalid write range.');
      return {
        ...value,
        operation: value.operation,
        input: {
          ...filePath(input),
          offset: input.offset,
          content: base64(input.content),
          ...(typeof input.truncate === 'boolean' ? { truncate: input.truncate } : {}),
          ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
        },
      };
    }
    case 'file.write-files': {
      fields(input, ['root', 'relPath', 'files', 'createOnly']);
      if (input.createOnly !== undefined && typeof input.createOnly !== 'boolean')
        invalid('Invalid create-only policy.');
      if (!Array.isArray(input.files) || input.files.length > 256)
        invalid('Invalid bounded file batch.');
      const files = input.files.map((file) => {
        if (!object(file)) invalid('Invalid file entry.');
        fields(file, ['path', 'content', 'mode']);
        const relative = filePath({ root: '/', relPath: file.path }).relPath;
        if (file.mode !== undefined && !integer(file.mode, 0o777)) invalid('Invalid file mode.');
        return {
          path: relative,
          content: base64(file.content),
          ...(typeof file.mode === 'number' ? { mode: file.mode } : {}),
        };
      });
      return {
        ...value,
        operation: value.operation,
        input: {
          ...filePath(input),
          files,
          ...(typeof input.createOnly === 'boolean' ? { createOnly: input.createOnly } : {}),
        },
      };
    }
    case 'file.delete':
      fields(input, ['root', 'relPath', 'expectedHash']);
      if (input.expectedHash === null) invalid('Delete requires an existing file hash.');
      if (path.normalize(filePath(input).relPath) === '.')
        invalid('File deletion cannot remove its admitted root.');
      return {
        ...value,
        operation: value.operation,
        input: {
          ...filePath(input),
          ...(input.expectedHash !== undefined
            ? { expectedHash: expectedHash(input.expectedHash) }
            : {}),
        },
      };
    case 'file.rename': {
      fields(input, ['root', 'oldRelPath', 'newRelPath', 'expectedHash']);
      if (input.expectedHash === null) invalid('Rename requires an existing file hash.');
      const old = filePath({ root: input.root, relPath: input.oldRelPath });
      const next = filePath({ root: input.root, relPath: input.newRelPath });
      return {
        ...value,
        operation: value.operation,
        input: {
          root: old.root,
          oldRelPath: old.relPath,
          newRelPath: next.relPath,
          ...(input.expectedHash !== undefined
            ? { expectedHash: expectedHash(input.expectedHash) }
            : {}),
        },
      };
    }
    case 'file.commit': {
      fields(input, [
        'root',
        'stagedRelPath',
        'destinationRelPath',
        'sha256',
        'size',
        'createOnly',
      ]);
      const staged = filePath({ root: input.root, relPath: input.stagedRelPath });
      const destination = filePath({ root: input.root, relPath: input.destinationRelPath });
      if (
        typeof input.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        !integer(input.size, Number.MAX_SAFE_INTEGER) ||
        (input.createOnly !== undefined && typeof input.createOnly !== 'boolean')
      )
        invalid('Invalid transfer commit.');
      if (staged.relPath === destination.relPath || path.normalize(destination.relPath) === '.')
        invalid('Transfer requires a distinct file destination.');
      return {
        ...value,
        operation: value.operation,
        input: {
          root: staged.root,
          stagedRelPath: staged.relPath,
          destinationRelPath: destination.relPath,
          sha256: input.sha256,
          size: input.size,
          ...(typeof input.createOnly === 'boolean' ? { createOnly: input.createOnly } : {}),
        },
      };
    }
    case 'process.run':
      return { ...value, operation: value.operation, input: parseNodeLinkProcess(input) };
    default:
      throw new NodeLinkFailure(
        'UNSUPPORTED_OPERATION',
        'Node does not implement this typed operation.',
      );
  }
}
