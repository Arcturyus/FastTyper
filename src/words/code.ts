/**
 * Pool « Code & chiffres » : jetons pour travailler la rangée du haut (chiffres)
 * et les symboles courants en programmation. Statique, pas issu d'une fréquence
 * réelle — juste un échantillon varié de nombres et de motifs syntaxiques.
 */

const NUMBERS: string[] = [];
for (let i = 0; i < 10; i++) NUMBERS.push(String(i));
for (const n of [10, 12, 16, 24, 32, 42, 64, 99, 100, 128, 255, 256, 404, 500,
  512, 1000, 1024, 2048, 3.14, 0.5, 1.5, 2.5, 0.0, 10.0, 100.0, 42.0]) {
  NUMBERS.push(String(n));
}

const SYMBOLS: string[] = [
  "{}", "()", "[]", "<>", "=>", "->", "::", ";;", "&&", "||", "==", "!=", "===",
  "<=", ">=", "++", "--", "+=", "-=", "*=", "/=", "?.", "??", "!!", "//", "/*",
  "*/", "**", "|>", "<-", "()=>", "{};", "[];", "();", "});", "})", "([", "])",
  "i++", "j--", "x=0", "y=1", "n+1", "i<n", "a[i]", "b[0]", "0x1F", "0b10",
  "$_", "_x", "fn()", "()", "=>{", "});", "||=", "&&=", "?:", "...", "..",
];

const KEYWORDS: string[] = [
  "let", "const", "var", "func", "def", "int", "for", "if", "else", "return",
  "true", "false", "null", "void", "new", "class", "this", "async", "await",
  "import", "export", "from", "type", "enum", "case", "break", "while", "do",
];

export const CODE_WORDS: string[] = [...NUMBERS, ...SYMBOLS, ...KEYWORDS];
