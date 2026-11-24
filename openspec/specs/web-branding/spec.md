# web-branding Specification

## Purpose
How the web application identifies itself in a browser tab, a bookmark and a shortcut: its title and its icons.

## Requirements

### Requirement: The site answers the browser's default icon request
The web application SHALL answer `GET /favicon.ico` with the TonyAI mark, signed in or not, so that a browser, a bookmark or a tool that asks for the default icon path gets the product's icon and not an error.

#### Scenario: A signed-out browser asks for the default icon
- **WHEN** a client with no session requests `/favicon.ico`
- **THEN** the answer is 200 with an icon image, not a redirect to the sign-in page and not 404

#### Scenario: The tab shows the product's mark
- **WHEN** a user opens the sign-in page in a browser that ignores the page's own icon links
- **THEN** the tab shows the TonyAI mark
