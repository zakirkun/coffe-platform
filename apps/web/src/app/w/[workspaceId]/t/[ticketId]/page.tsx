import { TicketPage } from '@/components/ticket/ticket-page';

export default async function Page({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  return <TicketPage ticketId={ticketId} />;
}
