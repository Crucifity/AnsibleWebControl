# Ревизия кода — 0.0.10.7

## Область ревизии

Проверена ветка `0.0.10.7`, созданная от `0.0.10.1`.

Основные файлы:
- `web1x.py`
- `public/common.js`
- `public/main.js`
- `public/hosts_info.js`
- `public/editor.js`
- `public/main.html`
- `public/hosts_info.html`
- `public/editor.html`

## Функции `web1x.py`

| Функция | Назначение |
|---|---|
| `safe` | Нормализует пользовательское имя пути до имени файла/каталога. |
| `project_dir` | Возвращает абсолютный каталог проекта. |
| `single_project` | Определяет режим проекта с единственным каталогом `playbooks`. |
| `get_projects` | Возвращает список доступных проектов. |
| `get_objects` | Возвращает список объектов проекта. |
| `object_dir` | Определяет рабочий каталог выбранного объекта. |
| `read` | Безопасно читает текстовый файл. |
| `write` | Создаёт каталог при необходимости и записывает текстовый файл. |
| `paths` | Формирует пути к inventory, defaults и `ansible.cfg`. |
| `roles_dir` | Возвращает каталог ролей объекта. |
| `log` | Добавляет сообщение в ограниченный журнал выполнения. |
| `load_inventory` | Загружает YAML inventory и обрабатывает ошибки YAML. |
| `load_hosts` | Возвращает секцию `all.hosts` inventory. |
| `classify_node` | Определяет тип и шаблон узла по набору параметров. |
| `parse_hosts` | Преобразует inventory-хосты в структуру для UI. |
| `template_schemas` | Собирает схемы параметров шаблонов узлов. |
| `inventory_groups` | Строит список групп и входящих в них хостов, включая вложенные группы. |
| `save_hosts` | Сохраняет inventory в YAML. |
| `scalar` | Преобразует строковые значения `true/false/null` и целые числа в типизированные значения. |
| `_hosts_section_bounds` | Находит границы секции `hosts` в YAML-тексте. |
| `_host_entry_indexes` | Находит строки отдельных хостов в секции `hosts`. |
| `_host_name_from_line` | Извлекает имя хоста из строки YAML. |
| `_host_yaml_block` | Формирует YAML-блок одного хоста с сохранением отступов и перевода строк. |
| `_group_hosts_bounds` | Находит секцию `hosts` указанной группы. |
| `_group_entry_indexes` | Находит записи хостов внутри группы. |
| `_insert_host_into_group` | Добавляет хост в группу, создавая группу при необходимости. |
| `_remove_host_from_group` | Удаляет хост из группы. |
| `_cleanup_empty_groups` | Удаляет группы без хостов. |
| `add_host` | Добавляет новый хост в inventory и выбранные группы. |
| `delete_host` | Удаляет хост из inventory и всех групп. |
| `save_host` | Обновляет параметры хоста и, при необходимости, его имя во всех группах. |
| `get_playbooks` | Возвращает YAML-плейбуки объекта, исключая служебные файлы. |
| `playbook_roles` | Анализирует playbook и строит дерево используемых ролей. |
| `role_file` | Безопасно разрешает путь файла внутри каталога ролей. |
| `autodeploy` | Возвращает путь к `autodeploy.yml`, если он существует. |
| `host_up` | Проверяет доступность узла через ICMP ping. |
| `status_worker` | Фоново обновляет статусы всех узлов. |
| `status` | Возвращает сохранённый статус выбранного проекта/объекта. |
| `run_playbook` | Запускает Ansible-процесс, пишет его вывод в журнал и отслеживает процесс. |
| `run_command` | Запускает выбранные playbook-файлы с ограничением по хостам. |
| `run_autodeploy` | Запускает `autodeploy.yml`. |
| `stop` | Завершает все запущенные Ansible-процессы. |
| `Handler.json` | Отправляет JSON-ответ HTTP-клиенту. |
| `Handler.file` | Отдаёт статический файл. |
| `Handler.do_GET` | Обрабатывает GET API, статические файлы, inventory, роли, статусы и журнал. |
| `Handler.do_POST` | Обрабатывает запуск Ansible и операции изменения inventory/playbook-файлов. |

### Вложенные функции Python

- `paths.first` — выбирает первый существующий вариант имени файла.
- `inventory_groups.collect` — рекурсивно собирает хосты из группы и её children.
- `playbook_roles.inspect` — рекурсивно извлекает роли из YAML playbook.
- `playbook_roles.walk` — рекурсивно строит дерево файлов каталога роли.
- `status_worker.check_node` — проверяет доступность одного узла.

## Функции `public/common.js`

- `getParams` — читает query-параметры текущего URL.
- `getProjectFromURL` — получает проект из URL.
- `getObjectFromURL` — получает объект из URL.
- `escapeHTML` — экранирует HTML-символы.
- `projectSelectorHTML` — генерирует HTML селектора проектов.
- `injectProjectSelectorStyles` — добавляет CSS кастомных селекторов и панелей.
- `positionObjectSelectorList` — позиционирует выпадающий список объектов.
- `enhanceObjectSelector` — превращает обычный `<select>` объекта в кастомный список.
- `injectRoleAndModalBehavior` — подключает обработчики раскрытия ролей и динамических README.
- `injectNav` — обновляет навигационную часть страницы и селекторы.
- `toggleProjectSelector` — открывает/закрывает селектор проекта.
- `closeProjectSelector` — закрывает селектор проекта.
- `selectProjectOption` — выбирает проект и инициирует переход.
- `changeProject` — меняет проект в URL.
- `changeObject` — меняет объект в URL.

### Вложенные функции `common.js`

- `enhanceObjectSelector.sync` — синхронизирует кастомный список с `<select>`.
- `injectRoleAndModalBehavior.updateRoleAncestors` — пересчитывает высоту родительских панелей ролей.
- `injectRoleAndModalBehavior.animateRolePanel` — анимирует раскрытие/сворачивание панели ролей.
- `injectRoleAndModalBehavior.loadRoleReadmes` — лениво загружает README ролей.
- `injectRoleAndModalBehavior.toggleRoleDirAnimated` — раскрывает каталог роли.
- `injectRoleAndModalBehavior.togglePlaybookRolesAnimated` — раскрывает дерево ролей playbook.

### Мёртвый код, найденный в `common.js`

- `navHTML()` всегда возвращает пустую строку и не содержит поведения. `injectNav()` присваивает её `#nav`, поэтому функция является избыточной.

## Функции `public/main.js`

- `esc` — HTML-экранирование.
- `api` — единый POST-клиент API с обработкой ошибок.
- `selectedHosts` — возвращает выбранные узлы.
- `selectedPlaybooks` — возвращает выбранные playbook.
- `updateHostSelectionButton` — обновляет подпись кнопки выбора узлов.
- `toggleHostSelection` — выбирает или снимает выбор со всех узлов.
- `selectPB` — массово устанавливает состояние чекбоксов playbook.
- `templateLabel` — возвращает отображаемое имя шаблона узла.
- `renderNode` — генерирует карточку узла.
- `animatePanel` — анимирует раскрытие/сворачивание карточки.
- `toggleNodeFromHead` — исключает клики по кнопкам/checkbox и передаёт управление раскрытию.
- `toggleNode` — раскрывает/сворачивает карточку узла.
- `editNode` — включает редактирование узла.
- `cancelNodeEdit` — отменяет редактирование через повторную загрузку данных.
- `saveNode` — сохраняет изменения узла.
- `deleteSelectedNodes` — удаляет выбранные узлы после подтверждения.
- `openAddNodeModal` — открывает форму добавления узла.
- `renderTemplateTabs` — строит вкладки шаблонов параметров.
- `selectTemplate` — выбирает шаблон параметров.
- `renderTemplateFields` — строит поля параметров выбранного шаблона.
- `createNode` — создаёт узел с выбранными группами.
- `renderGroups` — отображает фильтр групп.
- `toggleGroupFilter` — открывает/закрывает фильтр групп.
- `selectGroupFilter` — применяет фильтр группы.
- `clearGroupFilter` — снимает фильтр группы.
- `toggleGroupSelector` — открывает список групп в модальном окне.
- `renderGroupCheckboxes` — строит чекбоксы групп.
- `toggleGroupSelection` — добавляет/удаляет группу из выбора.
- `updateSelectedGroupsDisplay` — отображает выбранные группы.
- `removeGroupFromSelection` — удаляет группу из выбранных.
- `openCreateGroupModal` — создаёт/открывает динамическое окно создания группы.
- `closeCreateGroupModal` — закрывает окно создания группы.
- `confirmCreateGroup` — валидирует и добавляет новую группу к текущему выбору.
- `contextQuery` — строит query string проекта/объекта.
- `editPlaybook` — загружает playbook в модальный редактор.
- `savePlaybookFromModal` — сохраняет playbook из модального редактора.
- `fitPlaybookEditor` — подбирает ширину редактора под самую длинную строку.
- `groupHosts` — нормализует список хостов группы в `Set`.
- `renderNodes` — отображает узлы с учётом фильтра группы.
- `renderAutodeploy` — отображает блок авторазвёртывания.
- `roleTree` — строит HTML-дерево ролей.
- `renderPlaybooks` — отображает список playbook.
- `openRoleFile` — открывает файл роли в новом окне.
- `runAutodeploy` — запускает авторазвёртывание.
- `runSelected` — запускает выбранные playbook.
- `stopExecution` — останавливает выполнение.
- `showConfirmation` — показывает универсальное окно подтверждения.
- `interceptRunButtons` — перехватывает запуск и добавляет подтверждение.
- `updateNodeStatuses` — периодически обновляет статусы узлов.
- `loadMain` — загружает данные страницы и перерисовывает интерфейс.
- `refreshLog` — догружает новые строки журнала.

## Функции `public/hosts_info.js`

- `esc` — HTML-экранирование.
- `changeObject` — переключает объект и URL.
- `api` — выполняет POST-запрос с централизованной обработкой ошибок.
- `field` — строит поле параметра узла.
- `nodeType` — определяет тип узла по данным inventory.
- `nodeTypeLabel` — переводит тип узла в пользовательскую подпись.
- `card` — строит карточку узла со статусом и параметрами.
- `animatePanel` — анимирует раскрытие карточки.
- `toggleHost` — раскрывает/сворачивает карточку.
- `editHost` — переводит карточку в режим редактирования.
- `cancelEdit` — отменяет изменения перезагрузкой данных.
- `saveHost` — сохраняет изменения параметров узла.
- `deleteHost` — удаляет узел после подтверждения.
- `getNodeSchemas` — собирает наборы параметров для host/md.
- `selectNodeType` — выбирает тип нового узла.
- `renderNewNodeFields` — строит поля нового узла.
- `openAddNodeModal` — открывает форму добавления.
- `closeAddNodeModal` — закрывает форму добавления.
- `createNode` — создаёт узел на основании схемы.
- `load` — загружает данные страницы hosts.
- `rows` — строит список карточек.

## Функции `public/editor.js`

- `esc` — HTML-экранирование.
- `load` — загружает данные редактора и содержимое файлов.
- `loadPlaybook` — загружает выбранный playbook.
- `savePlaybook` — сохраняет playbook.
- `saveFiles` — сохраняет hosts/defaults с предварительной проверкой hosts.yml.

## Найденные проблемы, требующие исправления

1. **Критическая ошибка маршрутизации:** в `web1x.py` путь `/hosts_info.js` сопоставлен с `editor.js`, хотя `hosts_info.html` явно подключает `/hosts_info.js`. В результате страница hosts получает код редактора.
2. **Мёртвые static-маршруты:** в `web1x.py` заявлены `5x-fixes.css`, `5x-fixes.js`, `3x-fixes.css`, `3x-fixes.js`, `status-fix.js`, которых нет в ветке `0.0.10.7`.
3. **Дублирование логики ролей:** `main.html` содержит собственные `toggleRoleDir`/`togglePlaybookRoles` и `smoothPanel`, но `common.js` устанавливает capture-обработчик и перехватывает эти клики через `toggleRoleDirAnimated`/`togglePlaybookRolesAnimated`. Inline-реализация становится недостижимой и должна быть удалена.
4. **Дублирование HTML-экранирования:** `esc` реализован отдельно в `main.js`, `hosts_info.js`, `editor.js`, хотя `common.js` уже предоставляет `escapeHTML`. Это не удалялось автоматически, потому что требует согласованного изменения всех страниц.
5. **`navHTML()` — бесполезная прослойка:** функция возвращает пустую строку; её вызов можно убрать вместе с присваиванием `#nav.innerHTML`.
6. **Безопасность процесса:** `run_playbook()` использует `cwd` и переменные окружения корректно, а команды Ansible собираются списком без `shell=True`, что является хорошим решением и менять не следует.
7. **Безопасность путей:** `safe()` и проверки `role_file()` снижают риск выхода за пределы каталогов. Эти проверки также не следует удалять в рамках «чистки».

## Итог

Функциональная структура проекта в целом связная: Python-API обслуживает inventory/playbook/status, а JS разделён на общий слой, главную страницу, hosts и редактор. Основные кандидаты на чистку — дублированная логика ролей в `main.html`, пустой `navHTML()` и несуществующие static-маршруты. При этом обнаружена критичная ошибка `/hosts_info.js -> editor.js`, которую следует исправить до дальнейшего рефакторинга.
