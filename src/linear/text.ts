/* `$(name)` renders as a theme icon in a QuickPickItem's label, description AND detail, so any
   issue-derived text reaching a row has to be neutralised: a ticket titled `run $(bun test)` would
   otherwise be swallowed or drawn as a broken glyph.

   This file used to also hold a markdown-to-plain-text flattener, for a preview that was a native
   modal — a modal's body is plain text by API, so tables, images, checklists and fences all had to
   be approximated and the result truncated to keep the dialog from outgrowing the screen. The
   preview is a webview panel now and renders real markdown through VS Code's own renderer, so the
   whole flattener and its tests are gone rather than kept as dead code with a passing suite. */
export const escapeIcons = (text: string) => text.replaceAll("$(", "$​(");
