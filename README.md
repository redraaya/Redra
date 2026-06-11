# Redra

**Открой HTML. Кликни. Пиши.**

Redra — визуальный редактор HTML-файлов для macOS. Откройте любой HTML-файл —
он выглядит как в Chrome. Кликните в текст — и пишите. Перетащите блоки за
ручку, удалите лишнее, нажмите ⌘S — тот же файл сохранён на диск. Или
экспортируйте в PDF.

![Документ в Redra](docs/assets/redra-doc.png)

![Возможности Redra](docs/assets/features.png)

## Как это устроено

Правки живут поверх нетронутого исходника: при открытии файл разбирается
parse5 в эталонное дерево, а каждое действие пользователя записывается в
журнал операций. Живой DOM из окна никогда не сериализуется — при сохранении
журнал применяется к эталонному дереву, и в файл попадает только то, что вы
действительно поменяли. Сохранение без правок — байт-в-байт оригинал: ни
фантомных диффов под git, ни «причёсанной» разметки.

![Стартовый экран Redra](docs/assets/redra-start.png)

## Установка

1. Скачайте `Redra-<версия>-arm64.dmg` со страницы
   [Releases](https://github.com/redraaya/Redra/releases) (только Apple Silicon).
2. Откройте DMG и перетащите **Redra** в **Applications**.
3. **Первый запуск**: приложение не подписано сертификатом Apple, поэтому
   Gatekeeper заблокирует его с сообщением, что открыть не удалось. Это
   ожидаемо, действуйте так:
   1. Попробуйте открыть Redra (двойной клик) — появится предупреждение,
      нажмите «Готово»/«ОК».
   2. Откройте **Системные настройки → Конфиденциальность и безопасность**,
      прокрутите вниз — там появится кнопка **«Открыть всё равно»** напротив
      сообщения о Redra (кнопка возникает только после первой попытки
      запуска).
   3. Нажмите её и подтвердите открытие (понадобится пароль или Touch ID).

   Достаточно одного раза — дальше Redra открывается как обычно.
   Альтернатива в терминале:

   ```sh
   xattr -cr /Applications/Redra.app
   ```

После установки Redra появляется в Finder в меню «Открыть в программе…» для
файлов `.html` и `.htm`.

## Горячие клавиши

| Сочетание | Действие |
| --- | --- |
| ⌘O | Открыть файл |
| ⌘S | Сохранить |
| ⇧⌘S | Сохранить как… |
| ⌘E | Режим «Просмотр» (вкл/выкл редактирование) |
| ⇧⌘E | Экспорт в PDF… |
| ⌘Z | Отменить |
| ⇧⌘Z | Повторить |
| Esc | Отменить правку элемента (вернуть как было) или перетаскивание |
| ⌘-клик по ссылке | Открыть ссылку в браузере |

## Известные ограничения v1

- **iframe**: слой редактирования не достигает содержимого iframe — страница
  внутри iframe живёт своей жизнью и не редактируется.
- **`transform`/`filter` на `<html>`**: такие стили на корневом элементе
  создают новый containing block для `position: fixed` — плашка-ручка блока
  на подобных страницах может позиционироваться со смещением.
- Одно окно — один документ; относительные ссылки на соседние `.html`
  намеренно не работают до поддержки нескольких документов.

## Сборка из исходников

```sh
npm install
npm run dev        # запуск в режиме разработки
npm test           # тесты движка и оболочки
npm run smoke      # сборка + дымовой прогон настоящего окна
npm run dist       # DMG для Apple Silicon в dist/
```

## Лицензия

[MIT](LICENSE)

---

## English

**Open HTML. Click. Write.** Redra is a visual HTML file editor for macOS
(Apple Silicon). Open any HTML file — it renders like Chrome. Click into the
text and type, drag blocks by their handle, hit ⌘S — the same file is written
back to disk, or export to PDF.

Edits live as an operation journal on top of an untouched parse5 source tree;
the live DOM is never serialized. Saving with no edits writes the original
bytes back verbatim — no phantom git diffs.

Install: grab the DMG from
[Releases](https://github.com/redraaya/Redra/releases), drag Redra to
Applications. The app is not signed with an Apple certificate, so Gatekeeper
blocks the first launch: try to open Redra once, dismiss the warning, then go
to **System Settings → Privacy & Security**, scroll down and click
**"Open Anyway"** next to the Redra message (the button only appears after the
first launch attempt), and confirm. One time only — afterwards it opens
normally. Terminal alternative: `xattr -cr /Applications/Redra.app`.

License: [MIT](LICENSE).
