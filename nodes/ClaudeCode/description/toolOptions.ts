import type { INodePropertyOptions } from 'n8n-workflow';

/**
 * Built-in Claude Code tools (v2). The exact set varies by CLI version and
 * environment; unknown names are simply ignored. Shared by every tool
 * selector so the lists cannot drift apart.
 */
export const BUILT_IN_TOOL_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Artifact', value: 'Artifact', description: 'Publish an artifact page' },
	{ name: 'Bash', value: 'Bash', description: 'Execute bash commands' },
	{ name: 'CronCreate', value: 'CronCreate', description: 'Create a scheduled job' },
	{ name: 'CronDelete', value: 'CronDelete', description: 'Delete a scheduled job' },
	{ name: 'CronList', value: 'CronList', description: 'List scheduled jobs' },
	{ name: 'DesignSync', value: 'DesignSync', description: 'Sync design assets' },
	{ name: 'Edit', value: 'Edit', description: 'Edit files' },
	{ name: 'EnterWorktree', value: 'EnterWorktree', description: 'Enter a git worktree' },
	{ name: 'ExitWorktree', value: 'ExitWorktree', description: 'Exit a git worktree' },
	{ name: 'Glob', value: 'Glob', description: 'Find files by pattern' },
	{ name: 'Grep', value: 'Grep', description: 'Search file contents' },
	{ name: 'Monitor', value: 'Monitor', description: 'Watch a command or condition' },
	{ name: 'NotebookEdit', value: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
	{
		name: 'PushNotification',
		value: 'PushNotification',
		description: 'Send a notification',
	},
	{ name: 'Read', value: 'Read', description: 'Read file contents' },
	{ name: 'RemoteTrigger', value: 'RemoteTrigger', description: 'Trigger a remote agent' },
	{
		name: 'ReportFindings',
		value: 'ReportFindings',
		description: 'Report review findings',
	},
	{ name: 'ScheduleWakeup', value: 'ScheduleWakeup', description: 'Schedule a wake-up' },
	{ name: 'SendMessage', value: 'SendMessage', description: 'Message a running agent' },
	{ name: 'Skill', value: 'Skill', description: 'Invoke a skill' },
	{ name: 'Task', value: 'Task', description: 'Launch subagents for complex work' },
	{ name: 'TaskCreate', value: 'TaskCreate', description: 'Create a background task' },
	{ name: 'TaskGet', value: 'TaskGet', description: 'Get a background task' },
	{ name: 'TaskList', value: 'TaskList', description: 'List background tasks' },
	{ name: 'TaskOutput', value: 'TaskOutput', description: 'Read background task output' },
	{ name: 'TaskStop', value: 'TaskStop', description: 'Stop a background task' },
	{ name: 'TaskUpdate', value: 'TaskUpdate', description: 'Update a background task' },
	{ name: 'TodoWrite', value: 'TodoWrite', description: 'Manage todo lists' },
	{ name: 'ToolSearch', value: 'ToolSearch', description: 'Discover deferred tools' },
	{ name: 'WebFetch', value: 'WebFetch', description: 'Fetch web content' },
	{ name: 'WebSearch', value: 'WebSearch', description: 'Search the web' },
	{
		name: 'Workflow',
		value: 'Workflow',
		description: 'Run dynamic multi-agent workflows (required for Ultracode)',
	},
	{ name: 'Write', value: 'Write', description: 'Write files' },
];
