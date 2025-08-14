# SignalWire Code Test 
## Overview

This project is an AI-powered SMS helpdesk that integrates SignalWire for SMS handling, Cloudflare Workers for serverless execution, and Google Gemini for generating step-by-step IT support responses.

When a user sends an SMS to the configured SignalWire number, the message is sent to a Cloudflare Worker via webhook. The Worker calls Gemini with a helpdesk-specific prompt and sends the AI-generated response back as an SMS.

## Features

-Inbound SMS webhook via SignalWire <br/>
-AI-generated helpdesk replies with Gemini (gemini-1.5-flash-latest) <br/>
-Retry logic for Gemini API overloads (503) <br/>
-Dry run & JSON modes for testing without SMS delivery <br/>
-Content sanitization to keep replies SMS-friendly <br/>
-Serverless deployment with Cloudflare Workers <br/>

## How it works

User sends SMS to the SignalWire number, which forwards the message details to the Cloudflare Worker via cXML script attached to the number. <br/>
The Worker parses the message and sends it to Gemini with a helpdesk prompt, which then generates a simple troubleshooting reply. <br/> The Worker returns a LaML-compatible XML response, which SignalWire uses to send the SMS reply back to the user.

## Setup & Deployment 
Needs: SignalWire account, Cloudflare account, Google AI Studio API key
1. SignalWire <br/>
  -Create a phone number in SignalWire that supports SMS.<br/>
  -Go to Scripts in the SignalWire dashboard.<br/>
  -Click Create Script (Script Type: cXML) and give it a name.<br/>
  -Primary Script URL: Paste your Cloudflare Worker URL <br/>
  -Save the script. <br/>
  -Go to your phone number’s Messaging Settings and assign this script as the handler for inbound SMS. <br/>
  
2. Cloudflare <br/>
  -In the Cloudflare dashboard, go to Workers & Pages → Create Worker<br/>
  -Delete the default code and paste in the worker.js from this repo<br/>
  -Go to Settings → Variables → Add Secret:<br/>
    -Name: GEMINI_API_KEY<br/>
    -Value: your Gemini API key from Google AI Studio.<br/>
   -Save & Deploy your Worker.<br/>
   -Copy the Worker’s public URL for SignalWire’s Script URL (step 1.3).<br/>

3. Local testing with Postman (web version) <br/>
  -Verifies the integration without sending actual texts. <br/>
  -URL: https://<your-worker>.<subdomain>.workers.dev/?mode=json <br/>
  -Method: POST <br/>
  -Headers: Key = Content-Type, Value = application/x-www-form-urlencoded <br/>
  -Body type: x-www-form-urlencoded <br/>
   -From = +15550001111 <br/>
   -To = your SignalWire number <br/>
   -Body = "(insert question)" <br/>
   -Hit Send and an answer will be after the aiReply field. <br/>

*Note: Messages were able to be sent to the SignalWire number and a response was generated, but outbound messages failed due to error code 21717 ('From' must belong to an active campaign.). This is a limitation of the Trail version and should work properly with a number added to a messaging campaign. 

## Testing & Proof of Concept
These tests confirm that the Cloudflare Worker successfully processed inbound message data, generated a Gemini AI response, and returned the reply in both JSON mode and LaML-compatible XML. <br/>


## Key Design Decisions <br/>
Several choices were made to leverage free-tier services while still demonstrating the concept effectively: <br/>
-Gemini API was selected for its fast response times and generous free-tier access.<br/>
-Cloudflare Workers were chosen for their serverless, maintenance-free environment and low-latency performance, even on the free plan.<br/>
-XML webhook replies were used to simplify integration by directly responding to SignalWire without additional outbound API calls.<br/>
-Retry logic was implemented to handle instances where the Gemini API was overloaded and failed to return a response on the first attempt.<br/>

## Limitations
-Outbound SMS requires an active campaign for local numbers or a verified toll-free number. <br/>
-Trial accounts limits sending outbound messages without verification. <br/>
-Gemini API free tier occasionally returns errors; retry logic is included in workers to handle this.  <br/>

## Potential for Future Improvements
-Add multi-turn conversation memory. <br/>
-Implement a fallback AI if Gemini is unavailable. <br/>
-Add logging analytics to track usage trends. <br/>


