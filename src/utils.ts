/** Strip LaTeX $...$ delimiters that LLMs wrap around chess notation. */
export const stripLatex = (text: string) => text.replace(/\$([^$]+)\$/g, "$1");
