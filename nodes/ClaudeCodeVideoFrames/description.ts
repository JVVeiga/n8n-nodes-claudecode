import type { INodeTypeDescription } from 'n8n-workflow';
import { NodeConnectionType } from 'n8n-workflow';

export const videoFramesDescription: INodeTypeDescription = {
	displayName: 'Claude Code Video Frames',
	name: 'claudeCodeVideoFrames',
	icon: 'file:claudecodevideoframes.svg',
	group: ['transform'],
	version: 1,
	subtitle: '={{ { auto: "Auto", frames: "Frames", mosaic: "Mosaic" }[$parameter["mode"]] }}',
	description:
		'Turn a video into timestamped images Claude can read: single frames for a short clip, mosaics for a long one. Runs the ffmpeg installed on the n8n server, never a model.',
	defaults: {
		name: 'Claude Code Video Frames',
	},
	inputs: [{ type: NodeConnectionType.Main }],
	outputs: [{ type: NodeConnectionType.Main }],
	properties: [
		{
			displayName:
				'Claude cannot watch video. This node samples it into images, each with its time drawn on it, so the AI Agent (with Automatically Passthrough Binary Images on), the Claude Code node or the Claude Code Agent can look at them.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Binary Property',
			name: 'binaryProperty',
			type: 'string',
			default: 'data',
			required: true,
			description: 'The input binary property holding the video',
		},
		{
			displayName: 'Mode',
			name: 'mode',
			type: 'options',
			options: [
				{
					name: 'Auto',
					value: 'auto',
					description:
						'Single frames when each would cover 5 seconds or less, mosaics for anything longer',
				},
				{
					name: 'Frames',
					value: 'frames',
					description: 'One image per moment: the most detail, the least coverage',
				},
				{
					name: 'Mosaic',
					value: 'mosaic',
					description:
						'Several moments tiled into each image, each tile labelled with its time: the most coverage',
				},
			],
			default: 'auto',
		},
		{
			displayName: 'Max Images',
			name: 'maxImages',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 100 },
			default: 15,
			description:
				'How many images to output. 15 plus a subtitles file fits the 16 attachments the Claude Code node and Agent accept by default. Above 20, the API shrinks every image in the request.',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			options: [
				{
					displayName: 'Burn In Timestamps',
					name: 'burnTimestamps',
					type: 'boolean',
					default: true,
					description:
						'Whether to draw each frame’s time on it. The AI Agent passes images on without their names, so this is how the model knows when a frame is from.',
				},
				{
					displayName: 'End Time (Seconds)',
					name: 'endSec',
					type: 'number',
					typeOptions: { minValue: 0 },
					default: 0,
					description: 'Stop sampling here. 0 means the end of the video.',
				},
				{
					displayName: 'FFmpeg Path',
					name: 'ffmpegPath',
					type: 'string',
					default: '',
					description:
						"The ffmpeg binary to run. Empty uses FFMPEG_PATH, then ffmpeg on the PATH of the n8n server. ffmpeg is not bundled with this package: install it on the server (in n8n's Docker image: COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/).",
				},
				{
					displayName: 'Include Subtitles',
					name: 'includeSubtitles',
					type: 'boolean',
					default: true,
					description:
						'Whether to export a text subtitle track, when the file carries one, as an .srt binary property named "subtitles"',
				},
				{
					displayName: 'Keep Input Binary',
					name: 'keepInputBinary',
					type: 'boolean',
					default: false,
					description:
						'Whether to keep the video on the output item. Off by default: a Claude Code node with Attach All Binaries would otherwise receive the video again.',
				},
				{
					displayName: 'Max Video Size (MB)',
					name: 'maxVideoMb',
					type: 'number',
					typeOptions: { minValue: 1 },
					default: 2048,
				},
				{
					displayName: 'Minimum Interval (Seconds)',
					name: 'minIntervalSec',
					type: 'number',
					typeOptions: { minValue: 0.1, numberPrecision: 2 },
					default: 1,
					description: 'Never sample two moments closer than this',
				},
				{
					displayName: 'Mosaic Grid',
					name: 'grid',
					type: 'options',
					options: [
						{ name: '2 × 2', value: 2 },
						{ name: '3 × 3', value: 3 },
						{ name: '4 × 4', value: 4 },
					],
					default: 3,
					description:
						'Tiles per mosaic. More tiles cover more time per image but make each tile smaller; small on-screen text needs fewer.',
				},
				{
					displayName: 'Output Property Prefix',
					name: 'outputPrefix',
					type: 'string',
					default: 'frame',
					description: 'Images are written to prefix_000, prefix_001, … in time order',
				},
				{
					displayName: 'Start Time (Seconds)',
					name: 'startSec',
					type: 'number',
					typeOptions: { minValue: 0 },
					default: 0,
					description: 'Start sampling here. Combine with End Time to look closely at one stretch.',
				},
				{
					displayName: 'Timeout (Seconds)',
					name: 'timeoutSec',
					type: 'number',
					typeOptions: { minValue: 5 },
					default: 300,
					description:
						'A video with few keyframes needs a full decode: about 4 minutes per hour of 1080p on 2 CPUs',
				},
			],
		},
	],
};
