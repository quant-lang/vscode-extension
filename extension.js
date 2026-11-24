const vscode = require("vscode");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_QUD_PATH = "/usr/local/bin/qud";
const DIAGNOSTIC_SOURCE = "qud";
const CHANGE_DELAY_MS = 300;

/** @type {vscode.DiagnosticCollection | undefined} */
let diagnostics;
/** @type {Map<string, import("child_process").ChildProcess>} */
const running = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const scheduled = new Map();

function activate(context) {
    diagnostics = vscode.languages.createDiagnosticCollection("qud");

    context.subscriptions.push(
        diagnostics,
        vscode.languages.registerCompletionItemProvider(
            "quant-lang",
            {
                provideCompletionItems(document, position) {
                    const line = document.lineAt(position);
                    const text = line.text.substring(0, position.character);

                    const attributes = [
                        "entry",
                        "init",
                        "guard",
                        "public",
                        "private",
                        "hide",
                        "unhide",
                        "syscall",
                        "export",
                        "import",
                        "onbegin",
                        "onend"
                    ].map(attribute => {
                        return new vscode.CompletionItem(
                            attribute,
                            vscode.CompletionItemKind.Keyword
                        );
                    });

                    if (/@\w*$/.test(text)) {
                        return attributes;
                    }

                    const items = [];

                    const types = [
                        "i8",
                        "i16",
                        "i32",
                        "i64",
                        "u8",
                        "u16",
                        "u32",
                        "u64",
                        "f32",
                        "f64",
                        "bool",
                        "char",
                        "str",
                        "void",
                        "nullptr"
                    ];

                    for (const type of types) {
                        items.push(
                            new vscode.CompletionItem(
                                type,
                                vscode.CompletionItemKind.TypeParameter
                            )
                        );
                    }

                    const keywords = [
                        "func",
                        "struct",
                        "dynamic",
                        "enum",
                        "extern",
                        "return",
                        "if",
                        "else",
                        "while",
                        "using",
                        "load",
                        "break",
                        "continue",
                        "switch",
                        "case",
                        "default"
                    ];

                    for (const keyword of keywords) {
                        items.push(
                            new vscode.CompletionItem(
                                keyword,
                                vscode.CompletionItemKind.Keyword
                            )
                        );
                    }

                    return items;
                }
            },
            "@"
        ),
        vscode.workspace.onDidOpenTextDocument(scheduleDiagnostics),
        vscode.workspace.onDidChangeTextDocument(event => scheduleDiagnostics(event.document)),
        vscode.workspace.onDidSaveTextDocument(updateDiagnostics),
        vscode.workspace.onDidCloseTextDocument(clearDiagnostics)
    );

    for (const document of vscode.workspace.textDocuments) {
        scheduleDiagnostics(document);
    }
}

function deactivate() {
    for (const timer of scheduled.values()) {
        clearTimeout(timer);
    }
    scheduled.clear();

    for (const child of running.values()) {
        child.kill();
    }
    running.clear();

    if (diagnostics) {
        diagnostics.clear();
    }
}

function isQuantDocument(document) {
    return document.languageId === "quant-lang";
}

function qudSettings() {
    const config = vscode.workspace.getConfiguration("quant");
    return {
        path: config.get("qudPath", DEFAULT_QUD_PATH),
        target: config.get("qudTarget", "")
    };
}

function clearDiagnostics(document) {
    const key = document.uri.toString();

    const timer = scheduled.get(key);
    if (timer) {
        clearTimeout(timer);
        scheduled.delete(key);
    }

    const child = running.get(key);
    if (child) {
        child.kill();
        running.delete(key);
    }

    if (diagnostics) {
        diagnostics.delete(document.uri);
    }
}

function scheduleDiagnostics(document) {
    if (!isQuantDocument(document)) {
        return;
    }

    const key = document.uri.toString();
    const previous = scheduled.get(key);
    if (previous) {
        clearTimeout(previous);
    }

    scheduled.set(key, setTimeout(() => {
        scheduled.delete(key);
        updateDiagnostics(document);
    }, CHANGE_DELAY_MS));
}

function updateDiagnostics(document) {
    if (!isQuantDocument(document) || !diagnostics) {
        return;
    }

    const key = document.uri.toString();
    const timer = scheduled.get(key);
    if (timer) {
        clearTimeout(timer);
        scheduled.delete(key);
    }

    const previous = running.get(key);
    if (previous) {
        previous.kill();
    }

    const version = document.version;
    const settings = qudSettings();
    const args = [document.uri.fsPath];
    if (settings.target) {
        args.push("--target", settings.target);
    }

    const child = spawn(settings.path, args);
    running.set(key, child);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdin.on("error", () => { /* qud may exit before all input is written */ });
    child.stdin.end(document.getText());

    child.on("error", error => {
        if (running.get(key) === child) {
            running.delete(key);
        }
        console.error(`qud: ${error.message}`);
    });

    child.on("close", code => {
        if (running.get(key) !== child) {
            return; // cancelled, replaced by a newer run, or document closed
        }
        running.delete(key);

        if (document.isClosed || document.version !== version) {
            return;
        }

        // qud exits with 1 when the source contains diagnostics.
        if (code !== 0 && code !== 1) {
            console.error(`qud exited with ${code}: ${stderr.trim()}`);
            return;
        }

        try {
            diagnostics.set(document.uri, parseDiagnostics(stdout, document));
        } catch (error) {
            console.error(`qud: failed to parse diagnostics: ${error.message}`);
        }
    });
}

function parseDiagnostics(output, document) {
    const report = JSON.parse(output);
    const entries = Array.isArray(report.errors) ? report.errors : [];
    const result = [];

    for (const entry of entries) {
        const range = diagnosticRange(entry, document);
        if (!range) {
            continue;
        }

        const diagnostic = new vscode.Diagnostic(
            range,
            typeof entry.message === "string" ? entry.message : "Quant error",
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = DIAGNOSTIC_SOURCE;
        result.push(diagnostic);
    }

    return result;
}

function diagnosticRange(entry, document) {
    let file = entry.file;
    let line = positiveInt(entry.line);
    let column = positiveInt(entry.column);
    let length = positiveInt(entry.length);

    // Older qud builds put "file:line:column" into `lexeme` instead of
    // separate fields; both shapes occur in the wild (see quant/lsp/qud.cpp).
    if ((line === undefined || column === undefined) && typeof entry.lexeme === "string") {
        const match = entry.lexeme.match(/^(.*):(\d+):(\d+)$/);
        if (match) {
            file = match[1];
            line = Number(match[2]);
            column = Number(match[3]);
        }
    }

    if (file && !isSameFile(file, document)) {
        return null;
    }

    line = Math.max(1, line ?? 1);
    column = Math.max(1, column ?? 1);
    length = Math.max(1, length ?? 1);

    if (line > document.lineCount) {
        return null;
    }

    const start = new vscode.Position(line - 1, column - 1);
    const end = new vscode.Position(line - 1, column - 1 + length);
    return new vscode.Range(start, end);
}

function positiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : undefined;
}

function isSameFile(file, document) {
    try {
        return vscode.Uri.file(file).toString() === document.uri.toString()
            || path.resolve(file) === path.resolve(document.uri.fsPath);
    } catch (_) {
        return false;
    }
}

module.exports = { activate, deactivate };
