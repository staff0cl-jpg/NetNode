import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type NotificationType = 'success' | 'error' | 'info';

export type NotificationItem = {
  id: string;
  type: NotificationType;
  title?: string;
  message: string;
  durationMs?: number;
};

type NotificationInput = Omit<NotificationItem, 'id'>;

type NotificationsContextValue = {
  notifications: NotificationItem[];
  notify: (input: NotificationInput) => string;
  notifySuccess: (message: string, title?: string, durationMs?: number) => string;
  notifyError: (message: string, title?: string, durationMs?: number) => string;
  notifyInfo: (message: string, title?: string, durationMs?: number) => string;
  removeNotification: (id: string) => void;
};

const NotificationsContext = createContext<NotificationsContextValue | undefined>(undefined);

const DEFAULT_DURATION_MS = 6000;

export const NotificationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  const removeNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(
    (input: NotificationInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const item: NotificationItem = {
        id,
        ...input,
      };
      setNotifications((prev) => [...prev, item]);
      const duration = Number.isFinite(input.durationMs) ? Number(input.durationMs) : DEFAULT_DURATION_MS;
      if (duration > 0) {
        window.setTimeout(() => {
          removeNotification(id);
        }, duration);
      }
      return id;
    },
    [removeNotification]
  );

  const notifySuccess = useCallback(
    (message: string, title?: string, durationMs?: number) => notify({ type: 'success', message, title, durationMs }),
    [notify]
  );
  const notifyError = useCallback(
    (message: string, title?: string, durationMs?: number) => notify({ type: 'error', message, title, durationMs }),
    [notify]
  );
  const notifyInfo = useCallback(
    (message: string, title?: string, durationMs?: number) => notify({ type: 'info', message, title, durationMs }),
    [notify]
  );

  const value = useMemo(
    () => ({
      notifications,
      notify,
      notifySuccess,
      notifyError,
      notifyInfo,
      removeNotification,
    }),
    [notifications, notify, notifySuccess, notifyError, notifyInfo, removeNotification]
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
};

export const useNotifications = () => {
  const context = useContext(NotificationsContext);
  if (!context) throw new Error('useNotifications must be used within NotificationsProvider');
  return context;
};
