/**
 * Telegram Userbot Service — Per-user MTProto
 *
 * All functions now accept userId to get the correct per-user GramJS client.
 * Backward-compatible: if userId is omitted, falls back to legacy singleton.
 */

import { Api } from 'telegram/tl';
import { getFragmentClientForUser, getFragmentClient } from '../fragment-service';

type TgMsg = {
  id:     number;
  text:   string;
  date:   number;
  from?:  string;
  fromId?: number;
};

type TgDialog = {
  id:     string;
  title:  string;
  type:   string;
  unread: number;
};

/** Get client for user (or legacy fallback) */
async function getClient(userId?: number) {
  if (userId) return getFragmentClientForUser(userId);
  return getFragmentClient();
}

export async function tgSendMessage(chatId: string | number, text: string, userId?: number): Promise<number> {
  const client = await getClient(userId);
  const result = await (client as any).sendMessage(chatId, { message: text }) as any;
  return result?.id ?? 0;
}

export async function tgGetMessages(chatId: string | number, limit = 20, userId?: number): Promise<TgMsg[]> {
  const client = await getClient(userId);
  const msgs = await (client as any).getMessages(chatId, { limit }) as any[];
  return msgs.map((m: any) => ({
    id:     m.id,
    text:   m.message || '',
    date:   m.date,
    from:   m.sender?.username || m.sender?.firstName || '',
    fromId: m.senderId?.toJSNumber?.() ?? m.senderId,
  }));
}

export async function tgGetChannelInfo(chatId: string | number, userId?: number): Promise<{
  id: string; title: string; username?: string; membersCount?: number; description?: string;
}> {
  const client = await getClient(userId);
  const entity = await (client as any).getEntity(chatId) as any;
  return {
    id:           String(entity.id),
    title:        entity.title || entity.firstName || String(chatId),
    username:     entity.username,
    membersCount: entity.participantsCount,
    description:  entity.about,
  };
}

export async function tgJoinChannel(channelUsername: string, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).invoke(new Api.channels.JoinChannel({
    channel: await (client as any).getEntity(channelUsername),
  }));
}

export async function tgLeaveChannel(channelUsername: string | number, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).invoke(new Api.channels.LeaveChannel({
    channel: await (client as any).getEntity(channelUsername),
  }));
}

export async function tgGetDialogs(limit = 20, userId?: number): Promise<TgDialog[]> {
  const client = await getClient(userId);
  const dialogs = await (client as any).getDialogs({ limit }) as any[];
  return dialogs.map((d: any) => ({
    id:     String(d.id),
    title:  d.title || d.name || String(d.id),
    type:   d.isChannel ? 'channel' : d.isGroup ? 'group' : 'user',
    unread: d.unreadCount || 0,
  }));
}

export async function tgGetMembers(chatId: string | number, limit = 50, userId?: number): Promise<{
  id: number; username?: string; name: string;
}[]> {
  const client = await getClient(userId);
  const participants = await (client as any).getParticipants(chatId, { limit }) as any[];
  return participants.map((p: any) => ({
    id:       p.id?.toJSNumber?.() ?? Number(p.id),
    username: p.username,
    name:     [p.firstName, p.lastName].filter(Boolean).join(' ') || p.username || String(p.id),
  }));
}

export async function tgForwardMessage(fromChatId: string | number, messageId: number, toChatId: string | number, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).forwardMessages(toChatId, {
    messages: [messageId],
    fromPeer: fromChatId,
  });
}

export async function tgDeleteMessage(chatId: string | number, messageId: number, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).deleteMessages(chatId, [messageId], { revoke: true });
}

export async function tgSearchMessages(chatId: string | number, query: string, limit = 20, userId?: number): Promise<TgMsg[]> {
  const client = await getClient(userId);
  const msgs = await (client as any).getMessages(chatId, { limit, search: query }) as any[];
  return msgs.map((m: any) => ({
    id:     m.id,
    text:   m.message || '',
    date:   m.date,
    from:   m.sender?.username || m.sender?.firstName || '',
    fromId: m.senderId?.toJSNumber?.() ?? m.senderId,
  }));
}

export async function tgGetUserInfo(userIdentifier: string | number, userId?: number): Promise<{
  id: number; username?: string; firstName?: string; lastName?: string; bio?: string; phone?: string;
}> {
  const client = await getClient(userId);
  const entity = await (client as any).getEntity(userIdentifier) as any;
  return {
    id:        entity.id?.toJSNumber?.() ?? Number(entity.id),
    username:  entity.username,
    firstName: entity.firstName,
    lastName:  entity.lastName,
    bio:       entity.about,
    phone:     entity.phone,
  };
}

export async function tgSendFile(chatId: string | number, filePath: string, caption?: string, userId?: number): Promise<number> {
  const client = await getClient(userId);
  const result = await (client as any).sendFile(chatId, { file: filePath, caption }) as any;
  return result?.id ?? 0;
}

export async function tgReplyMessage(chatId: string | number, replyToMsgId: number, text: string, userId?: number): Promise<number> {
  const client = await getClient(userId);
  const result = await (client as any).sendMessage(chatId, {
    message: text,
    replyTo: replyToMsgId,
  }) as any;
  return result?.id ?? 0;
}

export async function tgReactMessage(chatId: string | number, messageId: number, emoji: string, userId?: number): Promise<void> {
  const client = await getClient(userId);
  const peer = await (client as any).getInputEntity(chatId);
  await (client as any).invoke(new Api.messages.SendReaction({
    peer,
    msgId: messageId,
    reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
  }));
}

export async function tgEditMessage(chatId: string | number, messageId: number, newText: string, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).editMessage(chatId, { message: messageId, text: newText });
}

export async function tgPinMessage(chatId: string | number, messageId: number, silent = true, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).pinMessage(chatId, messageId, { notify: !silent });
}

export async function tgMarkRead(chatId: string | number, userId?: number): Promise<void> {
  const client = await getClient(userId);
  await (client as any).markAsRead(chatId);
}

export async function tgGetComments(chatId: string | number, postMsgId: number, limit = 30, userId?: number): Promise<TgMsg[]> {
  const client = await getClient(userId);
  try {
    const peer = await (client as any).getInputEntity(chatId);
    const result = await (client as any).invoke(new Api.messages.GetReplies({
      peer, msgId: postMsgId,
      offsetId: 0, offsetDate: 0, addOffset: 0,
      limit, maxId: 0, minId: 0, hash: 0 as any,
    })) as any;
    return (result.messages || []).map((m: any) => ({
      id:     m.id,
      text:   m.message || '',
      date:   m.date,
      from:   '',
      fromId: m.fromId?.userId?.toJSNumber?.() ?? m.fromId?.userId ?? 0,
    }));
  } catch {
    return [];
  }
}

export async function tgSetTyping(chatId: string | number, seconds = 3, userId?: number): Promise<void> {
  const client = await getClient(userId);
  const peer = await (client as any).getInputEntity(chatId);
  await (client as any).invoke(new Api.messages.SetTyping({
    peer,
    action: new Api.SendMessageTypingAction(),
  }));
}

export async function tgSendFormatted(chatId: string | number, html: string, replyTo?: number, userId?: number): Promise<number> {
  const client = await getClient(userId);
  const result = await (client as any).sendMessage(chatId, {
    message: html,
    parseMode: 'html',
    replyTo: replyTo || undefined,
  }) as any;
  return result?.id ?? 0;
}

export async function tgGetMessageById(chatId: string | number, messageId: number, userId?: number): Promise<TgMsg | null> {
  const client = await getClient(userId);
  try {
    const msgs = await (client as any).getMessages(chatId, { ids: [messageId] }) as any[];
    if (msgs.length === 0) return null;
    const m = msgs[0];
    return {
      id:     m.id,
      text:   m.message || '',
      date:   m.date,
      from:   m.sender?.username || m.sender?.firstName || '',
      fromId: m.senderId?.toJSNumber?.() ?? m.senderId,
    };
  } catch {
    return null;
  }
}

export async function tgGetUnread(limit = 10, userId?: number): Promise<{ chatId: string; title: string; unread: number; lastMessage: string }[]> {
  const client = await getClient(userId);
  const dialogs = await (client as any).getDialogs({ limit: 50 }) as any[];
  return dialogs
    .filter((d: any) => (d.unreadCount || 0) > 0)
    .slice(0, limit)
    .map((d: any) => ({
      chatId: String(d.id),
      title: d.title || d.name || String(d.id),
      unread: d.unreadCount || 0,
      lastMessage: d.message?.message?.slice(0, 200) || '',
    }));
}

/**
 * Build a sandbox-safe userbot object for agent execution.
 * Now accepts userId for per-user isolation.
 */
export function buildUserbotSandbox(userId?: number) {
  return {
    sendMessage:    (chatId: string | number, text: string) => tgSendMessage(chatId, text, userId),
    getMessages:    (chatId: string | number, limit?: number) => tgGetMessages(chatId, limit, userId),
    getChannelInfo: (chatId: string | number) => tgGetChannelInfo(chatId, userId),
    joinChannel:    (channelUsername: string) => tgJoinChannel(channelUsername, userId),
    leaveChannel:   (channelUsername: string | number) => tgLeaveChannel(channelUsername, userId),
    getDialogs:     (limit?: number) => tgGetDialogs(limit, userId),
    getMembers:     (chatId: string | number, limit?: number) => tgGetMembers(chatId, limit, userId),
    forwardMessage: (from: string | number, msgId: number, to: string | number) => tgForwardMessage(from, msgId, to, userId),
    deleteMessage:  (chatId: string | number, msgId: number) => tgDeleteMessage(chatId, msgId, userId),
    searchMessages: (chatId: string | number, query: string, limit?: number) => tgSearchMessages(chatId, query, limit, userId),
    getUserInfo:    (user: string | number) => tgGetUserInfo(user, userId),
    sendFile:       (chatId: string | number, file: string, caption?: string) => tgSendFile(chatId, file, caption, userId),
    replyMessage:   (chatId: string | number, replyTo: number, text: string) => tgReplyMessage(chatId, replyTo, text, userId),
    reactMessage:   (chatId: string | number, msgId: number, emoji: string) => tgReactMessage(chatId, msgId, emoji, userId),
    editMessage:    (chatId: string | number, msgId: number, text: string) => tgEditMessage(chatId, msgId, text, userId),
    pinMessage:     (chatId: string | number, msgId: number, silent?: boolean) => tgPinMessage(chatId, msgId, silent, userId),
    markRead:       (chatId: string | number) => tgMarkRead(chatId, userId),
    getComments:    (chatId: string | number, postId: number, limit?: number) => tgGetComments(chatId, postId, limit, userId),
    setTyping:      (chatId: string | number, seconds?: number) => tgSetTyping(chatId, seconds, userId),
    sendFormatted:  (chatId: string | number, html: string, replyTo?: number) => tgSendFormatted(chatId, html, replyTo, userId),
    getMessageById: (chatId: string | number, msgId: number) => tgGetMessageById(chatId, msgId, userId),
    getUnread:      (limit?: number) => tgGetUnread(limit, userId),
  };
}
