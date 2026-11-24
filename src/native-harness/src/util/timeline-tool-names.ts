/** Reserved names also identify retrieval exchanges during history projection. */
export const timelineToolNames = ["search_timeline", "read_message"] as const;
export const isTimelineTool = (name: string): boolean => timelineToolNames.some(value => value === name);
