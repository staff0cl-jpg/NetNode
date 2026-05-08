import React from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useNotifications } from '../lib/notifications';
import { useTranslation } from '../lib/i18n';

const NotificationCenter: React.FC = () => {
  const { notifications, removeNotification } = useNotifications();
  const { t } = useTranslation();

  return (
    <div className="fixed top-4 right-4 z-[200] flex w-[min(92vw,420px)] flex-col gap-2 pointer-events-none">
      {notifications.map((item) => {
        const style =
          item.type === 'success'
            ? {
                icon: <CheckCircle2 size={16} className="text-[#40c057] shrink-0 mt-0.5" />,
                border: 'border-[#2f9e44]',
                bg: 'bg-[#18241b]',
                title: t('notifySuccessTitle'),
              }
            : item.type === 'error'
              ? {
                  icon: <XCircle size={16} className="text-[#fa5252] shrink-0 mt-0.5" />,
                  border: 'border-[#e03131]',
                  bg: 'bg-[#2b1619]',
                  title: t('notifyErrorTitle'),
                }
              : {
                  icon: <Info size={16} className="text-[#4dabf7] shrink-0 mt-0.5" />,
                  border: 'border-[#1c7ed6]',
                  bg: 'bg-[#16202b]',
                  title: t('notifyInfoTitle'),
                };

        const resolvedTitle = item.title ? t(item.title) : style.title;
        const resolvedMessage = t(item.message);

        return (
          <div
            key={item.id}
            className={`notification-toast notification-toast--${item.type} pointer-events-auto rounded border ${style.border} ${style.bg} p-3 shadow-xl backdrop-blur`}
            role="status"
            aria-live="polite"
          >
            <div className="flex items-start gap-2">
              <span className="notification-toast__icon">{style.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="notification-toast__title text-xs font-semibold text-white">{resolvedTitle}</p>
                <p className="notification-toast__message mt-0.5 text-xs text-[#c1c2c5] whitespace-pre-wrap break-words">
                  {resolvedMessage}
                </p>
              </div>
              <button
                type="button"
                aria-label={t('notifyClose')}
                className="notification-toast__close text-[#909296] hover:text-white"
                onClick={() => removeNotification(item.id)}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default NotificationCenter;
