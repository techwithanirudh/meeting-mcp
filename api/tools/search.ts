/**
 * MCP tools for searching meeting content
 */

import type { Context, TextContent } from "fastmcp";
import { z } from "zod";
import { apiRequest } from "../api/client.js";
import { Transcript } from "../types/index.js";
import { formatTime } from "../utils/formatters.js";
import { getTinyDb, BotRecord } from "../utils/tinyDb.js";
import { createValidSession } from "../utils/auth.js";

// Define our session auth type
type SessionAuth = { apiKey: string };

// Update the SessionAuth interface to include recentBotIds
interface ExtendedSessionAuth extends SessionAuth {
  recentBotIds?: string[];
}

// Define the parameters schema
const searchTranscriptParams = z.object({
  botId: z.string().uuid().describe("ID of the bot that recorded the meeting"),
  query: z.string().describe("Text to search for in the transcript"),
});

// New schema for searching by meeting type
const searchTranscriptByTypeParams = z.object({
  meetingType: z.string().describe("Type of meeting to search (e.g., 'sales', 'psychiatric', 'standup')"),
  query: z.string().describe("Text to search for in the transcripts"),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results to return"),
});

// New schema for finding meeting topics
const findMeetingTopicParams = z.object({
  meetingId: z.string().describe("ID of the meeting to search"),
  topic: z.string().describe("Topic to search for"),
});

// New schema for searching video segments by timestamp
const searchVideoSegmentParams = z.object({
  botId: z.string().uuid().describe("ID of the bot that recorded the meeting"),
  startTime: z.number().optional().describe("Start time in seconds (optional)"),
  endTime: z.number().optional().describe("End time in seconds (optional)"),
  speaker: z.string().optional().describe("Filter by speaker name (optional)"),
});

// New schema for intelligent search with flexible parameters
const intelligentSearchParams = z.object({
  query: z.string().describe("Natural language search query - can include mentions of topics, speakers, dates, or any search terms"),
  botId: z.string().describe("ID of the bot/meeting to search - this is required"),
  maxResults: z.number().int().min(1).max(50).optional().default(20).describe("Maximum number of results to return"),
  includeContext: z.boolean().optional().default(true).describe("Whether to include conversation context around matching segments"),
  sortBy: z.enum(["relevance", "date", "speaker"]).optional().default("relevance").describe("How to sort the results"),
  filters: z.record(z.string(), z.any()).optional().describe("Optional filters to narrow search results (meetingType, speaker, dateRange, etc.)"),
});

// Tool type with correct typing
type Tool<P extends z.ZodType<any, any>> = {
  name: string;
  description: string;
  parameters: P;
  execute: (
    args: z.infer<P>,
    context: Context<SessionAuth>
  ) => Promise<string | { content: TextContent[] }>;
};

// Update the Transcript interface to include end_time
interface ExtendedTranscript extends Transcript {
  end_time?: number;
  bot_name?: string;
  meeting_url?: string;
  bot_id?: string;
  meeting_type?: string;
}

// Define interfaces for the calendar event data structure
interface CalendarEvent {
  name: string;
  uuid: string;
  start_time: string;
  bot_param: {
    uuid?: string;
    extra?: {
      meetingType?: string;
    };
  } | null;
}

/**
 * Search meeting transcripts
 */
export const searchTranscriptTool: Tool<typeof searchTranscriptParams> = {
  name: "searchTranscript",
  description: "Search through a meeting transcript for specific terms",
  parameters: searchTranscriptParams,
  execute: async (args, context) => {
    const { session, log } = context;
    // Cast as ExtendedSessionAuth but handle the case where it might not be fully initialized
    const extendedSession = session as ExtendedSessionAuth;
    
    log.info("Searching transcripts", { botId: args.botId, query: args.query });

    // Create a valid session with fallbacks for API key
    const validSession = createValidSession(session, log);
    
    // Check if we have a valid session with API key
    if (!validSession) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Authentication failed. Please configure your API key in Claude Desktop settings or provide it directly."
          }
        ],
        isError: true
      };
    }

    try {
    const response = await apiRequest(
        validSession,
      "get",
      `/bots/meeting_data?bot_id=${args.botId}`
    );

      // Track this bot in our TinyDB
      const metadata = extractBotMetadata(response);
      // Try to update recent bots, but don't let it fail the main functionality
      try {
        updateRecentBots(extendedSession, args.botId, metadata);
      } catch (e) {
        // Log but continue even if tracking fails
        log.warn("Failed to track recent bot", { error: String(e) });
      }

    const transcripts: Transcript[] = response.bot_data.transcripts;
    const results = transcripts.filter((transcript: Transcript) => {
      const text = transcript.words
        .map((word: { text: string }) => word.text)
        .join(" ");
      return text.toLowerCase().includes(args.query.toLowerCase());
    });

    if (results.length === 0) {
      return `No results found for "${args.query}"`;
    }

    // Format the results
    const formattedResults = results
      .map((transcript: Transcript) => {
        const text = transcript.words
          .map((word: { text: string }) => word.text)
          .join(" ");
        const startTime = formatTime(transcript.start_time);
        const speaker = transcript.speaker;

        return `[${startTime}] ${speaker}: ${text}`;
      })
      .join("\n\n");

    return `Found ${results.length} results for "${args.query}":\n\n${formattedResults}`;
    } catch (error) {
      log.error(`Error searching transcripts`, { error: String(error) });
      return `Error searching transcripts: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/**
 * Search transcripts by meeting type
 * This tool leverages the 'extra' field to search for content in specific meeting types
 */
export const searchTranscriptByTypeTool: Tool<typeof searchTranscriptByTypeParams> = {
  name: "searchTranscriptByType",
  description: "Search through meeting transcripts of a specific meeting type",
  parameters: searchTranscriptByTypeParams,
  execute: async (args, context) => {
    const { session, log } = context;
    const extendedSession = session as ExtendedSessionAuth;
    
    log.info("Searching transcripts by type", { meetingType: args.meetingType, query: args.query });

    // Create a valid session with fallbacks for API key
    const validSession = createValidSession(session, log);
    
    // Check if we have a valid session with API key
    if (!validSession) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Authentication failed. Please configure your API key in Claude Desktop settings or provide it directly."
          }
        ],
        isError: true
      };
    }

    try {
      // First, get list of all bots
      const botsResponse = await apiRequest(
        validSession,
        "get",
        "/bots/all?limit=100&offset=0"
      );

      // Filter bots by meeting type using the 'extra' field
      const filteredBots = botsResponse.filter((bot: any) => {
        return bot.extra && 
               bot.extra.meetingType && 
               bot.extra.meetingType.toLowerCase() === args.meetingType.toLowerCase();
      });

      if (filteredBots.length === 0) {
        return `No meetings found with type "${args.meetingType}"`;
      }

      // Search each matching bot's transcripts
      let allResults: any[] = [];
      for (const bot of filteredBots.slice(0, args.limit)) {
        try {
          const response = await apiRequest(
            session,
            "get",
            `/bots/meeting_data?bot_id=${bot.uuid}`
          );

          // Track this bot in our TinyDB
          try {
            const metadata = extractBotMetadata(response);
            updateRecentBots(extendedSession, bot.uuid, metadata);
          } catch (e) {
            // Log but continue even if tracking fails
            log.warn("Failed to track recent bot", { error: String(e) });
          }

          if (response.bot_data && response.bot_data.transcripts) {
            const transcripts: Transcript[] = response.bot_data.transcripts;
            const results = transcripts.filter((transcript: Transcript) => {
              const text = transcript.words
                .map((word: { text: string }) => word.text)
                .join(" ");
              return text.toLowerCase().includes(args.query.toLowerCase());
            }).map(transcript => {
              return {
                ...transcript,
                bot_name: response.bot_data.bot.bot_name,
                meeting_url: response.bot_data.bot.meeting_url,
                bot_id: bot.uuid,
                meeting_type: args.meetingType
              };
            });
            
            allResults = [...allResults, ...results];
          }
        } catch (error) {
          log.error(`Error searching bot ${bot.uuid}`, { error: String(error) });
          // Continue with other bots even if one fails
        }
      }

      // Sort results by start_time
      allResults.sort((a, b) => a.start_time - b.start_time);
      
      // Limit results
      allResults = allResults.slice(0, args.limit);

      if (allResults.length === 0) {
        return `No results found for "${args.query}" in "${args.meetingType}" meetings`;
      }

      // Format the results
      const formattedResults = allResults
        .map((result) => {
          const text = result.words
            .map((word: { text: string }) => word.text)
            .join(" ");
          const startTime = formatTime(result.start_time);
          const speaker = result.speaker;
          const botName = result.bot_name;

          return `Bot: ${botName}\n[${startTime}] ${speaker}: ${text}\nView full meeting: ${result.meeting_url}`;
        })
        .join("\n\n");

      return `Found ${allResults.length} results for "${args.query}" in "${args.meetingType}" meetings:\n\n${formattedResults}`;
    } catch (error) {
      log.error(`Error searching transcripts by type`, { error: String(error) });
      return `Error searching transcripts by type: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/**
 * Find specific topics within meeting content
 */
export const findMeetingTopicTool: Tool<typeof findMeetingTopicParams> = {
  name: "findMeetingTopic",
  description: "Search for specific topics discussed in a meeting",
  parameters: findMeetingTopicParams,
  execute: async (args, context) => {
    const { session, log } = context;
    const extendedSession = session as ExtendedSessionAuth;
    log.info("Finding meeting topic", { meetingId: args.meetingId, topic: args.topic });

    // Create a valid session with fallbacks for API key
    const validSession = createValidSession(session, log);
    
    // Check if we have a valid session with API key
    if (!validSession) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Authentication failed. Please configure your API key in Claude Desktop settings or provide it directly."
          }
        ],
        isError: true
      };
    }

    try {
      const response = await apiRequest(
        validSession,
        "get",
        `/bots/meeting_data?bot_id=${args.meetingId}`
      );

      // Track this bot in our TinyDB
      try {
        const metadata = extractBotMetadata(response);
        updateRecentBots(extendedSession, args.meetingId, metadata);
      } catch (e) {
        // Log but continue even if tracking fails
        log.warn("Failed to track recent bot", { error: String(e) });
      }

      // Get complete transcript text
      const transcripts: Transcript[] = response.bot_data.transcripts;
      
      // Combine all transcript segments into a single text
      const fullText = transcripts.map((transcript: Transcript) => {
        const text = transcript.words
          .map((word: { text: string }) => word.text)
          .join(" ");
        return `[${formatTime(transcript.start_time)}] ${transcript.speaker}: ${text}`;
      }).join("\n");
      
      // Check if the topic is mentioned anywhere
      if (!fullText.toLowerCase().includes(args.topic.toLowerCase())) {
        return `Topic "${args.topic}" was not discussed in this meeting.`;
      }
      
      // Find contextual segments that mention the topic
      const results = transcripts.filter((transcript: Transcript) => {
        const text = transcript.words
          .map((word: { text: string }) => word.text)
          .join(" ");
        return text.toLowerCase().includes(args.topic.toLowerCase());
      });

      // Get surrounding context (transcript segments before and after matches)
      let contextualResults: Transcript[] = [];
      for (let i = 0; i < results.length; i++) {
        const resultIndex = transcripts.findIndex(t => t.start_time === results[i].start_time);
        
        // Get up to 2 segments before and after the match for context
        const startIdx = Math.max(0, resultIndex - 2);
        const endIdx = Math.min(transcripts.length - 1, resultIndex + 2);
        
        for (let j = startIdx; j <= endIdx; j++) {
          if (!contextualResults.includes(transcripts[j])) {
            contextualResults.push(transcripts[j]);
          }
        }
      }
      
      // Sort by start time
      contextualResults.sort((a, b) => a.start_time - b.start_time);
      
      // Format the results with context
      const formattedResults = contextualResults
        .map((transcript: Transcript) => {
          const text = transcript.words
            .map((word: { text: string }) => word.text)
            .join(" ");
          const startTime = formatTime(transcript.start_time);
          const speaker = transcript.speaker;
          
          const highlightedText = text.replace(
            new RegExp(`(${args.topic})`, "gi"), 
            "**$1**"
          );

          return `[${startTime}] ${speaker}: ${highlightedText}`;
        })
        .join("\n\n");

      return `Found topic "${args.topic}" in the meeting with context:\n\n${formattedResults}\n\nVideo URL: ${response.mp4}`;
    } catch (error) {
      log.error(`Error finding meeting topic`, { error: String(error) });
      return `Error finding meeting topic: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/**
 * Search for specific segments of a meeting video by time, speaker, or other criteria
 */
export const searchVideoSegmentTool: Tool<typeof searchVideoSegmentParams> = {
  name: "searchVideoSegment",
  description: "Search for specific segments in a meeting recording by time or speaker",
  parameters: searchVideoSegmentParams,
  execute: async (args, context) => {
    const { session, log } = context;
    // Safe handling of extendedSession
    const extendedSession = session as ExtendedSessionAuth;
    
    log.info("Searching video segments", { 
      botId: args.botId,
      startTime: args.startTime,
      endTime: args.endTime,
      speaker: args.speaker
    });

    // Create a valid session with fallbacks for API key
    const validSession = createValidSession(session, log);
    
    // Check if we have a valid session with API key
    if (!validSession) {
      return {
        content: [
          {
            type: "text" as const,
            text: "Authentication failed. Please configure your API key in Claude Desktop settings or provide it directly."
          }
        ],
        isError: true
      };
    }

    try {
      const response = await apiRequest(
        validSession,
        "get",
        `/bots/meeting_data?bot_id=${args.botId}`
      );

      // Try to update recent bots, but don't let it fail the main functionality
      try {
        const metadata = extractBotMetadata(response);
        updateRecentBots(extendedSession, args.botId, metadata);
      } catch (e) {
        // Log but continue even if tracking fails
        log.warn("Failed to track recent bot", { error: String(e) });
      }

      const transcripts: Transcript[] = response.bot_data.transcripts;
      
      // Get all unique speakers to help with fuzzy speaker matching
      const allSpeakers = new Set<string>();
      transcripts.forEach((transcript: Transcript) => {
        if (transcript.speaker) {
          allSpeakers.add(transcript.speaker.trim());
        }
      });
      log.info(`Meeting speakers: ${Array.from(allSpeakers).join(', ')}`);
      
      // Filter transcripts based on parameters
      let filteredTranscripts = transcripts;
      
      // Apply time range filter if provided
      if (args.startTime !== undefined || args.endTime !== undefined) {
        filteredTranscripts = filteredTranscripts.filter((transcript: ExtendedTranscript) => {
          // Calculate approximate end time (start_time + 5 seconds is a reasonable estimate if not available)
          const endTime = transcript.end_time !== undefined ? transcript.end_time : transcript.start_time + 5;
          
          // Check if transcript is within the specified time range
          if (args.startTime !== undefined && transcript.start_time < args.startTime) {
            return false;
          }
          if (args.endTime !== undefined && endTime > args.endTime) {
            return false;
          }
          return true;
        });
      }
      
      // Apply speaker filter if provided, with improved fuzzy matching
      if (args.speaker) {
        // First, see if we can find an exact match among known speakers
        const speakerLower = args.speaker.toLowerCase();
        const exactMatch = Array.from(allSpeakers).find(
          s => s.toLowerCase() === speakerLower
        );
        
        if (exactMatch) {
          // If we have an exact match, use it
          log.info(`Found exact speaker match: ${exactMatch}`);
          filteredTranscripts = filteredTranscripts.filter((transcript: Transcript) => 
            transcript.speaker.toLowerCase() === speakerLower
          );
        } else {
          // Otherwise, try fuzzy matching by looking for speakers containing the search term
          log.info(`Using fuzzy speaker match for: ${args.speaker}`);
          
          // First find which speakers partially match the search term
          const matchingSpeakers = Array.from(allSpeakers).filter(
            s => s.toLowerCase().includes(speakerLower) || 
                 speakerLower.includes(s.toLowerCase().split(' ')[0]) // Match on first name too
          );
          
          if (matchingSpeakers.length > 0) {
            log.info(`Found fuzzy speaker matches: ${matchingSpeakers.join(', ')}`);
            filteredTranscripts = filteredTranscripts.filter((transcript: Transcript) => 
              matchingSpeakers.includes(transcript.speaker)
            );
          } else {
            // Fall back to the old behavior if no matches found
            filteredTranscripts = filteredTranscripts.filter((transcript: Transcript) => 
              transcript.speaker.toLowerCase().includes(speakerLower)
            );
          }
        }
      }

      if (filteredTranscripts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matching video segments found based on your criteria."
            }
          ]
        };
      }

      // Format the results with direct video links
      const videoBaseUrl = response.mp4.split("?")[0]; // Remove any query parameters
      
      // Get the time boundaries
      const firstSegmentTime = filteredTranscripts[0].start_time;
      const lastSegmentTime = filteredTranscripts[filteredTranscripts.length - 1].start_time;
      
      // Create a timestamped video URL
      const videoUrlWithTimestamp = `${videoBaseUrl}?t=${Math.floor(firstSegmentTime)}`;
      
      // Format individual segments
      const formattedSegments = filteredTranscripts
        .map((transcript: Transcript) => {
          const text = transcript.words
            .map((word: { text: string }) => word.text)
            .join(" ");
          const startTime = formatTime(transcript.start_time);
          const speaker = transcript.speaker;
          
          // Create a segment-specific timestamped URL
          const segmentUrl = `${videoBaseUrl}?t=${Math.floor(transcript.start_time)}`;

          return `[${startTime}] ${speaker}: ${text}\nSegment link: ${segmentUrl}`;
        })
        .join("\n\n");

      const meetingDetails = response.bot_data.bot;
      
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${filteredTranscripts.length} segments from ${formatTime(firstSegmentTime)} to ${formatTime(lastSegmentTime)} in meeting "${meetingDetails.bot_name}".`
          },
          {
            type: "text" as const,
            text: `Watch from beginning of segment: ${videoUrlWithTimestamp}`
          },
          {
            type: "text" as const,
            text: `Individual segments:\n\n${formattedSegments}`
          }
        ]
      };
    } catch (error) {
      log.error("Error searching video segments", { error: String(error) });
      return `An error occurred during the search: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

/**
 * Intelligent adaptive search across all meeting data
 * This tool dynamically adjusts its search strategy based on the query and available context
 */
export const intelligentSearchTool: Tool<typeof intelligentSearchParams> = {
  name: "intelligentSearch",
  description: "Performs an intelligent search across meeting data, adapting to the query and available context",
  parameters: intelligentSearchParams,
  execute: async (args, context) => {
    const { session, log } = context;
    const extendedSession = session as ExtendedSessionAuth;
    log.info("Performing intelligent search", { query: args.query, botId: args.botId });
    
    try {
      // Create a valid session with fallbacks for API key
      const validSession = createValidSession(session, log);
      
      // Check if we have a valid session with API key
      if (!validSession) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Authentication failed. Please configure your API key in Claude Desktop settings or provide it directly."
            }
          ],
          isError: true
        };
      }
      
      // Initialize our TinyDB for persistent bot tracking
      const db = getTinyDb();
      
      // Extract parameters directly
      const botId = args.botId;
      let speaker: string | null = null;
      let timeRange = { startTime: undefined as number | undefined, endTime: undefined as number | undefined };
      
      // Process optional filter parameters
      if (args.filters) {
        if (args.filters.speaker) {
          speaker = args.filters.speaker;
          log.info(`Using speaker filter: ${speaker}`);
        }
        
        if (args.filters.startTime !== undefined) {
          timeRange.startTime = Number(args.filters.startTime);
        }
        
        if (args.filters.endTime !== undefined) {
          timeRange.endTime = Number(args.filters.endTime);
        }
      }
      
      // Try to extract time ranges from query as a convenience
      const timePatterns = [
        { regex: /between\s+(\d+)(?::(\d+))?\s+(?:and|to)\s+(\d+)(?::(\d+))?/i, type: "range" },
        { regex: /after\s+(\d+)(?::(\d+))?/i, type: "after" },
        { regex: /before\s+(\d+)(?::(\d+))?/i, type: "before" },
        { regex: /around\s+(\d+)(?::(\d+))?/i, type: "around" }
      ];
      
      for (const pattern of timePatterns) {
        const match = args.query.match(pattern.regex);
        if (match) {
          if (pattern.type === "range" && match[1] && match[3]) {
            const startMinutes = parseInt(match[1]) * 60 + (match[2] ? parseInt(match[2]) : 0);
            const endMinutes = parseInt(match[3]) * 60 + (match[4] ? parseInt(match[4]) : 0);
            timeRange.startTime = startMinutes;
            timeRange.endTime = endMinutes;
          } else if (pattern.type === "after" && match[1]) {
            const minutes = parseInt(match[1]) * 60 + (match[2] ? parseInt(match[2]) : 0);
            timeRange.startTime = minutes;
          } else if (pattern.type === "before" && match[1]) {
            const minutes = parseInt(match[1]) * 60 + (match[2] ? parseInt(match[2]) : 0);
            timeRange.endTime = minutes;
          } else if (pattern.type === "around" && match[1]) {
            const minutes = parseInt(match[1]) * 60 + (match[2] ? parseInt(match[2]) : 0);
            timeRange.startTime = Math.max(0, minutes - 60); // 1 minute before
            timeRange.endTime = minutes + 60; // 1 minute after
          }
          log.info(`Extracted time range: ${JSON.stringify(timeRange)}`);
          break;
        }
      }
      
      // Look for speaker names mentioned in the query
      // Common patterns like "what did [Name] say about..."
      const speakerPatterns = [
        /(?:what|when|where|how|why) did ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?) (?:say|talk|speak|mention|discuss)/i,
        /(?:statements|comments|opinions|thoughts) (?:from|by) ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
        /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)(?:'s) (?:statements|comments|opinions|thoughts)/i,
        /when ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?) (?:spoke|said|mentioned|discussed)/i
      ];
      
      // Try to extract speaker info from the query
      if (!speaker) {
        for (const pattern of speakerPatterns) {
          const match = args.query.match(pattern);
          if (match && match[1]) {
            speaker = match[1];
            log.info(`Extracted speaker from query: ${speaker}`);
            break;
          }
        }
      }
      
      // Extract the core search terms (removing filter-related phrases)
      let searchTerms = args.query
        .replace(/in\s+(sales|psychiatric|standup|interview|product|planning)\s+meetings?/gi, '')
        .replace(/from\s+yesterday|last\s+(week|day|month)|this\s+(month|quarter)/gi, '')
        .replace(/where\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?\s+(speak|said|talk|mention)/gi, '')
        .replace(/(?:meeting|bot)\s+(?:id|uuid)[\s:]+([a-f0-9-]{8,})/gi, '')
        .replace(/between\s+\d+(?::\d+)?\s+(?:and|to)\s+\d+(?::\d+)?/gi, '')
        .replace(/(?:after|before|around)\s+\d+(?::\d+)?/gi, '')
        .replace(/(?:what|when|where|how|why) did [A-Z][a-z]+(?:\s+[A-Z][a-z]+)? (?:say|talk|speak|mention|discuss)/gi, '')
        .replace(/(?:statements|comments|opinions|thoughts) (?:from|by) [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/gi, '')
        .replace(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?(?:'s) (?:statements|comments|opinions|thoughts)/gi, '')
        .replace(/when [A-Z][a-z]+(?:\s+[A-Z][a-z]+)? (?:spoke|said|mentioned|discussed)/gi, '')
        .trim();
        
      // If the cleaning removed everything, use the original query
      if (!searchTerms) {
        searchTerms = args.query;
      }
      
      log.info(`Search terms after filtering: ${searchTerms}`);
      
      try {
        // Get bot metadata to enhance response
        const botData = await apiRequest(
          validSession,
          "get",
          `/bots/meeting_data?bot_id=${botId}`
        );
        
        // Extract and store metadata for future searches
        const metadata = extractBotMetadata(botData);
        
        // Track this bot in TinyDB
        try {
          updateRecentBots(extendedSession, botId, metadata);
        } catch (e) {
          log.warn("Failed to track recent bot", { error: String(e) });
        }

        // Now let's implement a tiered search approach - from specific to general
        
        // TIER 1: If we have speaker AND search terms, use both for specific filtering
        if (speaker && searchTerms.trim() !== "") {
          // Try specific combined search first
          const videoSegmentResult = await searchVideoSegmentTool.execute({
            botId: botId,
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            speaker: speaker
          }, { ...context, session: validSession });
          
          // We'll manually filter results for the search terms after getting speaker segments
          if (typeof videoSegmentResult === 'object' && 
              videoSegmentResult.content && 
              videoSegmentResult.content.length > 0 &&
              !videoSegmentResult.content[0].text.includes("No matching video segments found")) {
              
            // We got speaker results, now filter them by search terms
            log.info(`Found speaker segments, now filtering by search terms: ${searchTerms}`);
            
            // We need to get the transcript data again
            const transcripts: Transcript[] = botData.bot_data.transcripts;
            
            // First get transcripts matching the speaker
            const speakerMatch = transcripts.filter((transcript: Transcript) => {
              const speakerLower = speaker!.toLowerCase();
              return transcript.speaker.toLowerCase().includes(speakerLower) || 
                     speakerLower.includes(transcript.speaker.toLowerCase().split(' ')[0]);
            });
            
            // Then filter those by search terms
            const searchTermWords = searchTerms.toLowerCase().split(/\s+/);
            const filteredByTerms = speakerMatch.filter((transcript: Transcript) => {
              const text = transcript.words
                .map((word: { text: string }) => word.text)
                .join(" ")
                .toLowerCase();
                
              // Consider a match if ANY of the search terms is found
              return searchTermWords.some(term => text.includes(term));
            });
            
            if (filteredByTerms.length > 0) {
              // Format results with direct video links
              const videoBaseUrl = botData.mp4.split("?")[0];
              const formattedSegments = filteredByTerms
                .map((transcript: Transcript) => {
                  const text = transcript.words
                    .map((word: { text: string }) => word.text)
                    .join(" ");
                  const startTime = formatTime(transcript.start_time);
                  const speakerName = transcript.speaker;
                  const segmentUrl = `${videoBaseUrl}?t=${Math.floor(transcript.start_time)}`;
                  return `[${startTime}] ${speakerName}: ${text}\nSegment link: ${segmentUrl}`;
                })
                .join("\n\n");
                
                const meetingDetails = botData.bot_data.bot;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Found ${filteredByTerms.length} segments where ${speaker} mentioned "${searchTerms}" in meeting "${meetingDetails.bot_name}".`
                    },
                    {
                      type: "text" as const,
                      text: `Watch from beginning: ${videoBaseUrl}?t=${Math.floor(filteredByTerms[0].start_time)}`
                    },
                    {
                      type: "text" as const,
                      text: `Individual segments:\n\n${formattedSegments}`
                    }
                  ]
                };
            }
          }
        }
        
        // TIER 2: If we have a speaker, try just speaker search
        if (speaker) {
          log.info(`Falling back to speaker-only search for: ${speaker}`);
          const speakerResult = await searchVideoSegmentTool.execute({
            botId: botId,
            startTime: timeRange.startTime,
            endTime: timeRange.endTime,
            speaker: speaker
          }, { ...context, session: validSession });
          
          // If we got results, return them
          if (typeof speakerResult === 'object' && 
              speakerResult.content && 
              speakerResult.content.length > 0 &&
              !speakerResult.content[0].text.includes("No matching video segments found")) {
            return speakerResult;
          }
        }
        
        // TIER 3: Try multi-term search by breaking query into individual terms
        if (searchTerms.trim() !== "") {
          const searchWords = searchTerms.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          
          if (searchWords.length > 1) {
            log.info(`Trying multi-term search with words: ${searchWords.join(', ')}`);
            
            // Get transcripts
            const transcripts: Transcript[] = botData.bot_data.transcripts;
            
            // Filter by multiple terms
            const multiTermResults = transcripts.filter((transcript: Transcript) => {
              const text = transcript.words
                .map((word: { text: string }) => word.text)
                .join(" ")
                .toLowerCase();
              
              // Count how many terms match
              const matchCount = searchWords.filter(term => text.includes(term)).length;
              
              // Consider it a match if at least half the terms are found
              return matchCount >= Math.max(1, Math.floor(searchWords.length / 2));
            });
            
            if (multiTermResults.length > 0) {
              // Format the results
              const videoBaseUrl = botData.mp4.split("?")[0];
              
              const formattedMultiTermResults = multiTermResults
                .map((transcript: Transcript) => {
                  const text = transcript.words
                    .map((word: { text: string }) => word.text)
                    .join(" ");
                  const startTime = formatTime(transcript.start_time);
                  const speakerName = transcript.speaker;
                  const segmentUrl = `${videoBaseUrl}?t=${Math.floor(transcript.start_time)}`;
                  return `[${startTime}] ${speakerName}: ${text}\nSegment link: ${segmentUrl}`;
                })
                .join("\n\n");
                
                const meetingDetails = botData.bot_data.bot;
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: `Found ${multiTermResults.length} segments related to "${searchTerms}" in meeting "${meetingDetails.bot_name}".`
                    },
                    {
                      type: "text" as const,
                      text: `Watch from beginning: ${videoBaseUrl}?t=${Math.floor(multiTermResults[0].start_time)}`
                    },
                    {
                      type: "text" as const,
                      text: `Individual segments:\n\n${formattedMultiTermResults}`
                    }
                  ]
                };
            }
          }
        }
        
        // TIER 4: Fall back to standard search for simple terms
        if (searchTerms.trim() !== "") {
          log.info(`Falling back to standard transcript search for: ${searchTerms}`);
          const result = await searchTranscriptTool.execute({
            botId: botId,
            query: searchTerms
          }, { ...context, session: validSession });
          
          return result;
        }
        
        // TIER 5: If nothing else worked, just use video segment search as a last resort
        log.info(`Using video segment search as last resort`);
        const result = await searchVideoSegmentTool.execute({
          botId: botId,
          startTime: timeRange.startTime,
          endTime: timeRange.endTime,
          speaker: speaker || undefined
        }, { ...context, session: validSession });
        
        return result;
      } catch (error) {
        log.error("Error searching meeting data", { error: String(error), botId });
        return `Error searching meeting ${botId}: ${error instanceof Error ? error.message : String(error)}`;
      }
      
    } catch (error) {
      log.error("Error in intelligent search", { error: String(error) });
      return `An error occurred during the search: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

// Helper function to update the session with recently used bot IDs
function updateRecentBots(session: ExtendedSessionAuth | undefined, botId: string, botMetadata?: Partial<BotRecord>) {
  // Skip if session doesn't exist
  if (!session) {
    return;
  }

  try {
    // Update the in-memory session for immediate use
    if (!session.recentBotIds) {
      session.recentBotIds = [];
    }
    
    // Remove this bot ID if it already exists in the list
    session.recentBotIds = session.recentBotIds.filter(id => id !== botId);
    
    // Add this bot ID to the front of the list
    session.recentBotIds.unshift(botId);
    
    // Keep only the 5 most recent bot IDs
    if (session.recentBotIds.length > 5) {
      session.recentBotIds = session.recentBotIds.slice(0, 5);
    }
    
    // Update the persistent database with this bot and its metadata
    const db = getTinyDb();
    if (botMetadata) {
      db.trackBot({
        id: botId,
        ...botMetadata
      });
    }
  } catch (error) {
    // Silently catch any errors with session manipulation
    // This ensures search functionality still works even if tracking doesn't
    console.error("Failed to update recent bots:", error);
  }
}

// Helper function to extract bot metadata from API response
function extractBotMetadata(apiResponse: any): Partial<BotRecord> {
  if (!apiResponse || !apiResponse.bot_data || !apiResponse.bot_data.bot) {
    return {};
  }
  
  const bot = apiResponse.bot_data.bot;
  
  // Extract key topics from transcripts if available
  const topics: string[] = [];
  if (apiResponse.bot_data.transcripts && Array.isArray(apiResponse.bot_data.transcripts)) {
    // This is a simplified approach - in a real implementation, you might
    // use NLP to extract actual topics from the transcript text
    const transcriptText = apiResponse.bot_data.transcripts
      .map((t: any) => t.words?.map((w: any) => w.text).join(' ') || '')
      .join(' ');
      
    // Extract common keywords as potential topics
    const commonKeywords = ['budget', 'project', 'deadline', 'timeline', 'goals', 'product'];
    commonKeywords.forEach(keyword => {
      if (transcriptText.toLowerCase().includes(keyword.toLowerCase())) {
        topics.push(keyword);
      }
    });
  }
  
  return {
    name: bot.bot_name,
    meetingUrl: bot.meeting_url,
    meetingType: bot.extra?.meetingType,
    createdAt: bot.created_at,
    creator: bot.creator_email,
    participants: bot.extra?.participants,
    topics: topics.length > 0 ? topics : undefined,
    extra: bot.extra
  };
}
