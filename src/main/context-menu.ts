import { Menu, MenuItem, type BrowserWindow } from 'electron';

export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    const { misspelledWord, dictionarySuggestions, isEditable, selectionText } = params;

    if (misspelledWord) {
      if (dictionarySuggestions.length > 0) {
        for (const suggestion of dictionarySuggestions.slice(0, 6)) {
          menu.append(
            new MenuItem({
              label: suggestion,
              click: () => win.webContents.replaceMisspelling(suggestion),
            }),
          );
        }
      } else {
        menu.append(
          new MenuItem({ label: 'No suggestions', enabled: false }),
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: 'Add to dictionary',
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(misspelledWord),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: selectionText.length > 0 }));
      menu.append(new MenuItem({ role: 'copy', enabled: selectionText.length > 0 }));
      menu.append(new MenuItem({ role: 'paste' }));
      menu.append(new MenuItem({ role: 'pasteAndMatchStyle' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (selectionText.length > 0) {
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) {
      menu.popup({ window: win });
    }
  });
}
