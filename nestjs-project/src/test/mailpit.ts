const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/** The fields of Mailpit's API responses that the tests read. */
interface MailpitAddress {
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

export interface MailpitMessage {
  HTML: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
