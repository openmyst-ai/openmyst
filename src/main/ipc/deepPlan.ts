import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/ipc-channels';
import type { ChairAnswerMap } from '@shared/types';
import {
  advancePhase,
  buildStatus,
  resetSession,
  runOneShot,
  sendUserMessage,
  skipSession,
  startSession,
  submitAnswers,
} from '../features/deepPlan';

export function registerDeepPlanIpc(): void {
  ipcMain.handle(IpcChannels.DeepPlan.Status, () => buildStatus());

  ipcMain.handle(IpcChannels.DeepPlan.Start, async (_event, task: unknown) => {
    if (typeof task !== 'string' || task.trim().length === 0) {
      throw new Error('Task description is required.');
    }
    return startSession(task);
  });

  ipcMain.handle(IpcChannels.DeepPlan.SendMessage, async (_event, message: unknown) => {
    if (typeof message !== 'string') throw new Error('Message must be a string.');
    return sendUserMessage(message);
  });

  ipcMain.handle(IpcChannels.DeepPlan.SubmitAnswers, async (_event, answers: unknown) => {
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new Error('Answers must be an object keyed by question id.');
    }
    return submitAnswers(answers as ChairAnswerMap);
  });

  ipcMain.handle(IpcChannels.DeepPlan.Advance, () => advancePhase());
  ipcMain.handle(IpcChannels.DeepPlan.Skip, () => skipSession());
  ipcMain.handle(IpcChannels.DeepPlan.OneShot, () => runOneShot());
  ipcMain.handle(IpcChannels.DeepPlan.Reset, () => resetSession());
}
