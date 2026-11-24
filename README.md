# Quant Lang VSCode Extension
Syntax highlighting, completions and compiler diagnostics for Quant.

## Diagnostics

Diagnostics come from `qud` (source: `quant/lsp/qud.cpp`). By default the
extension runs `/usr/local/bin/qud`, passes it the current file and feeds the
unsaved document text to its stdin, then shows the reported errors in the
Problems panel. Diagnostics are refreshed while typing and on save.

Use `quant.qudPath` to point at another `qud` executable and `quant.qudTarget`
to pass a `--target` to it.

## Quant Compiler

The Quant compiler is available at:
https://github.com/quant-lang/quant
