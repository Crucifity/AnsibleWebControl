# -*- coding: utf-8 -*-
"""Ansible Web Control: краткий итог выполнения плейбука по ролям и задачам.

Плагин обратного вызова типа aggregate — работает рядом со стандартным выводом (его не меняет).
Если задана переменная окружения AWC_REPORT_FILE, по окончании плейбука пишет туда JSON:
{"tasks": [{"role", "task", "ok", "changed", "failed", "skipped", "unreachable", "ignored", "hosts_failed"}],
 "hosts": {узел: {"ok", "changed", "failures", "unreachable", "skipped", ...}}}
Совместим с Ansible 2.9–2.16 и Python 2.7 / 3.5+.
"""
from __future__ import absolute_import, division, print_function
__metaclass__ = type

DOCUMENTATION = '''
    name: awc_report
    type: aggregate
    short_description: краткий итог выполнения для Ansible Web Control
    description:
      - Пишет JSON с итогами по ролям и задачам в файл из переменной окружения AWC_REPORT_FILE.
'''

import json
import os

from ansible.plugins.callback import CallbackBase


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = 'aggregate'
    CALLBACK_NAME = 'awc_report'
    # загружается сам, без callbacks_enabled (не трогаем списки callback в ansible.cfg пользователя)
    CALLBACK_NEEDS_ENABLED = False
    CALLBACK_NEEDS_WHITELIST = False

    def __init__(self, *args, **kwargs):
        super(CallbackModule, self).__init__(*args, **kwargs)
        self.report_path = os.environ.get('AWC_REPORT_FILE')
        self.tasks = []
        self.by_uuid = {}

    def _entry(self, task):
        key = getattr(task, '_uuid', None) or id(task)
        entry = self.by_uuid.get(key)
        if entry is None:
            role = task._role.get_name() if getattr(task, '_role', None) else ''
            name = (getattr(task, 'name', None) or task.get_name() or '').strip()
            if role and name.startswith(role + ' : '):
                name = name[len(role) + 3:]
            entry = {'role': role, 'task': name or task.action, 'ok': 0, 'changed': 0, 'failed': 0,
                     'skipped': 0, 'unreachable': 0, 'ignored': 0, 'hosts_failed': []}
            self.by_uuid[key] = entry
            self.tasks.append(entry)
        return entry

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._entry(task)

    def v2_playbook_on_handler_task_start(self, task):
        self._entry(task)

    def v2_runner_on_ok(self, result):
        entry = self._entry(result._task)
        entry['changed' if result._result.get('changed') else 'ok'] += 1

    def v2_runner_on_failed(self, result, ignore_errors=False):
        entry = self._entry(result._task)
        if ignore_errors:
            entry['ignored'] += 1
        else:
            entry['failed'] += 1
            entry['hosts_failed'].append(result._host.get_name())

    def v2_runner_on_skipped(self, result):
        self._entry(result._task)['skipped'] += 1

    def v2_runner_on_unreachable(self, result):
        entry = self._entry(result._task)
        entry['unreachable'] += 1
        entry['hosts_failed'].append(result._host.get_name())

    def v2_playbook_on_stats(self, stats):
        if not self.report_path:
            return
        hosts = {}
        for host in sorted(stats.processed.keys()):
            hosts[host] = stats.summarize(host)
        try:
            with open(self.report_path, 'w') as handle:
                json.dump({'tasks': self.tasks, 'hosts': hosts}, handle)
        except (IOError, OSError):
            pass
