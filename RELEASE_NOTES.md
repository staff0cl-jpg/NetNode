# NetNode Release Notes

Этот файл фиксирует изменения по версиям (как договорились: одна выкатка = одна версия).

## v1.0.3

Дата: 2026-05-08

- Topology: ручные связи отображаются только для активной вкладки/региона.
- Topology: авторазметка ограничена активной вкладкой (branch), добавлена защита от запуска без выбранной вкладки.
- UI: добавлен текст-подсказка при попытке запустить авторазметку без активной вкладки.
- Versioning: версия приложения обновлена до `1.0.3` и отображается в хедере через централизованный источник (`package.json`).

## v1.0.2

Дата: 2026-05-07

- UI: версия релиза выведена в правый верхний угол (header).
- Versioning: внедрена централизация версий:
  - версия берется из `package.json`,
  - пробрасывается в frontend через Vite define (`__APP_VERSION__`),
  - используется в UI через `src/lib/version.ts`.
- SSH: расширена матрица SSH-алгоритмов (modern + legacy), чтобы совместить новые Cisco и старые HP/HPE.
- Deployment: добавлен `.env` в репозиторий с `NETNODE_INITIAL_ADMIN_PASSWORD=admin` (по текущей договоренности для упрощенного старта).

## v1.0.1

Дата: 2026-05-07

- Automation MVP:
  - backend API: dry-run/apply/jobs/cancel;
  - target resolver по устройствам и портам (scope + filters + trunk-conditions);
  - vendor adapters для Cisco/HPE/Aruba/MikroTik;
  - job execution с batching/retry/error-threshold/cancel;
  - аудит действий автоматизации;
  - UI-мастер Automation (scenario -> target -> conditions -> dry-run -> apply);
  - история jobs и просмотр шагов выполнения;
  - настройки defaults для automation в Settings;
  - RU/EN i18n ключи для нового функционала.
- UI/UX:
  - mobile-responsive улучшения для основных экранов;
  - cleanup Settings (убраны/скрыты неактуальные элементы).
- Network discovery/topology:
  - улучшения FC/topology inference;
  - улучшения Cisco trunk hints;
  - оптимизации discovery и асинхронный запуск scan-job.

## Pre-versioned baseline

До введения формальной схемы `v1.0.x` проект развивался серией функциональных коммитов (core inventory/topology/dashboard/discovery/ssh/audit/readme). Базовая инициализация зафиксирована в раннем коммите `07ad60a`.

---

## Правило ведения release notes

Для каждой следующей выкладки:

1. Инкремент версии в `package.json`.
2. Добавление нового блока `## vX.Y.Z` в этот файл.
3. Кратко: дата, ключевые изменения, обратимые/рискованные изменения.
