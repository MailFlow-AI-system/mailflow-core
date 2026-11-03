export type Label = { id: string; name: string; color: string }
export type LabelCursor = { name: string; id: string }
export type LabelTarget = 'messages' | 'sent'
export type LabelRepository = {
  searchLabels(
    workspaceId: string,
    query: string,
    cursor: LabelCursor | null,
  ): Promise<{ items: Label[]; nextCursor: LabelCursor | null; exactMatch: Label | null }>
  suggestColor(workspaceId: string): Promise<string>
  createLabel(workspaceId: string, name: string, color?: string): Promise<Label | null>
  messageLabels(
    workspaceId: string,
    userId: string,
    target: LabelTarget,
    messageId: string,
  ): Promise<Label[] | null>
  changeMessageLabel(
    workspaceId: string,
    userId: string,
    target: LabelTarget,
    messageId: string,
    labelId: string,
    add: boolean,
  ): Promise<Label[] | null>
}
