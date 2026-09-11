# Ревизия кода — 0.0.11.6

## Область ревизии


Основные файлы:
- `web1x.py`
- `public/common.js`
- `public/main.js`
- `public/main.html`
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


## Найденные проблемы, требующие исправления

## Итог

