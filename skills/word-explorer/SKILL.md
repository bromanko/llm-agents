---
name: word-explorer
description: This skill should be used when the user provides a word and requests an exploration of its meaning, etymology, usage, and literary examples. The skill produces comprehensive, engaging word profiles that combine dictionary definitions, pronunciations, literary quotations, and practical usage guidance.
---

# Word Explorer

## Overview

This skill provides comprehensive word explorations that combine authoritative dictionary definitions, literary examples, and practical usage guidance. The goal is to create memorable, engaging profiles that help users understand and recall words effectively.

## When to Use This Skill

Use this skill when:
- The user provides a word and asks for its meaning, definition, or exploration
- The user requests examples of how a word is used in literature
- The user wants to learn about a word's etymology, pronunciation, or usage patterns
- The user asks for literary quotations or historical usage of a word

## Workflow

When the user provides a word, follow this process:

### 1. Search for Authoritative Definitions

**First, ensure the dictionary file is available:**

Check if the file `websters-1913.txt` exists in the skill directory. If it doesn't exist, download it:

```bash
curl -L -o websters-1913.txt \
  https://raw.githubusercontent.com/adambom/dictionary/master/dictionary.txt
```

(Run this from the skill directory: `plugins/word-explorer/skills/word-explorer/`)

**Then search the local dictionary:**

Use the Grep tool to search for the word in the local dictionary file:
- Pattern: `^[word]` (to match entries starting with the word)
- Use `-i` flag for case-insensitive search if needed
- Set output_mode to "content" to see the full definition
- Use `-A` parameter to capture multiple lines of the definition (start with 10-20 lines)

**Example:**
```
Grep with pattern: "^Serendipity"
File: websters-1913.txt (in this skill's directory)
Output mode: content
-A: 15
```

**Notes:**
- Note the pronunciation, part of speech, and primary definition
- Consider alternate spellings or related forms by searching for them too
- If Webster's 1913 lacks an entry (no results from Grep), fall back to searching modern dictionaries via web search:
  - Search Merriam-Webster: `[word] definition site:merriam-webster.com`
  - Search Etymology Online: `[word] site:etymonline.com`

### 2. Find Literary Examples

- Search Project Gutenberg (`gutenberg.org`) for usage in classic literature
- Look for examples from respected authors (Milton, Shakespeare, Austen, Dickens, Emerson, etc.)
- Search for contemporary usage examples from quality publications when relevant
- **Prioritize examples that are evocative, amusing, or showcase wordplay**
- Select quotations that are memorable and demonstrate the word's character, not just its definition

**Search query formats:**
```
"[word]" site:gutenberg.org [author name]
```
For specific works:
```
[word] Paradise Lost site:gutenberg.org
```

### 3. Search for Contemporary Usage (Optional)

When relevant, include modern examples to show the word's continued use:

**Search quality publications:**
```
[word] site:newyorker.com OR site:theatlantic.com OR site:nytimes.com
```

Look for examples from the past 5-10 years for current relevance.

### 4. Gather Etymological Information

- Note the word's origins (Latin, Greek, Old English, etc.) if available in Webster's 1913
- Include interesting historical context about the word's development when available
- This enriches the profile but is not always necessary

### 5. Create the Word Profile

Format the response in an engaging, conversational style with these elements:

**Structure:**

1. **Opening statement**: Brief characterization of the word
   - Example: "A straightforward 'good word,' one that everyone should know..."
   - Set the tone and give context for why the word matters

2. **Pronunciation**: Use phonetic spelling in quotes
   - Example: "Pronounced 'KA-vihl.'"
   - Use capital letters for stressed syllables

3. **Definition**: Start with a conversational explanation, followed by the formal Webster's 1913 definition in quotes with citation
   - Example: "It means to bitch and moan in a nitpicky way. Or more elegantly, 'To raise captious and frivolous objections; to find fault without good reason' (Webster's 1913)."

4. **Usage context**: Explain when/where the word is commonly used
   - Example: "People are fond of caviling so you'll find plenty of use for this one."

5. **Literary examples**: Include 1-2 quotations showing the word in use
   - **Select quotes that are evocative, amusing, or demonstrate wordplay**
   - Always include proper attribution: author, work, and line/chapter/page numbers when available
   - Introduce each quotation with context or a memorable connection
   - Example: "Think of the following line from Milton next time you hear someone complaining about their seat at the theater: 'Wilt thou enjoy the good, Then cavil the conditions?' (x. 759, Paradise Lost)"

6. **Contemporary example** (optional but encouraged): Include modern usage when it illuminates the word's continued relevance
   - Use parentheses to set it apart
   - Include year and source
   - Example: "(And here's a typical contemporary usage, from 2012: 'Republicans who cavil when Washington finances green-energy companies...')"

## Tone and Style Guidelines

- Write in a warm, enthusiastic tone that conveys appreciation for language
- Be conversational but not informal—maintain respect for the material
- Use phrases like "you'll find plenty of use for this one" or "think of this next time..."
- Make connections to everyday situations where the word applies
- Avoid academic dryness; aim for engaging prose that makes the word memorable
- Feel free to add personality and wit where appropriate
- **Keep it concise**: aim for 200-300 words total—every sentence should earn its place

## Quality Standards

- Always cite sources properly (author, work, location when available)
- Verify quotations are accurate before including them
- Prefer original, authoritative sources over secondary references
- Include at least one literary example that is evocative, amusing, or demonstrates wordplay
- **Keep profiles concise: 200-300 words maximum**
- Make the word memorable—users should be able to recall and use it after reading
- Prioritize quality over quantity—one perfect quote beats three mediocre ones

## Example Output

Here is an example of the expected format and style:

**cavil, v.** A straightforward "good word," one that everyone should know but that I used to have a hard time recalling, until I made an effort with it. Pronounced "KA-vihl." It means to bitch and moan in a nitpicky way. Or more elegantly, "To raise captious and frivolous objections; to find fault without good reason" (Webster's 1913). People are fond of caviling so you'll find plenty of use for this one. Think of the following line from Milton next time you hear someone complaining about their seat at the theater (or their table at the restaurant, or...): "Wilt thou enjoy the good, Then cavil the conditions?" (x. 759, Paradise Lost) (And here's a typical contemporary usage, from 2012: "Republicans who cavil when Washington finances green-energy companies are perfectly happy to see countless billions... spent on X-ray machines, electronic eavesdropping, and riot gear. Democrats, understandably eager not to be criticized as soft on security issues, are just as ready to spend.")
