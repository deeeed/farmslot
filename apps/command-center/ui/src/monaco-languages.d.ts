declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution' {
  export const typescriptDefaults: {
    setDiagnosticsOptions(options: {
      noSemanticValidation?: boolean;
      noSyntaxValidation?: boolean;
      noSuggestionDiagnostics?: boolean;
    }): void;
  };
  export const javascriptDefaults: typeof typescriptDefaults;
}
