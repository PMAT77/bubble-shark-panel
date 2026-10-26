-- Custom SQL migration file, put your code below! --
UPDATE `scheduled_tasks`
SET `kind` = 'update',
    `enabled` = 0,
    `next_run_at` = NULL,
    `last_run_status` = 'skipped',
    `last_run_message` = '已改为定时更新，请确认后启用'
WHERE `kind` = 'update_check';
