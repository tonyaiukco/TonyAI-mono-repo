# pdf-rendering Specification

## Purpose

Turns the API's own report HTML into a PDF in an isolated, bounded browser render that runs no script and reaches no network, so hostile text in a report can never act inside the renderer.

## Requirements

### Requirement: A render runs no script

A PDF render SHALL execute no JavaScript in the rendered document, inline or otherwise.

#### Scenario: A script in the document

- **WHEN** the HTML handed to the renderer contains an inline script that would change the page or make a request
- **THEN** the script does not run, and the PDF shows the document as written

### Requirement: A render reaches no network

A PDF render SHALL make no network request and no host lookup: every resource the document references over the network (http, https, ws, file) SHALL be refused before it is fetched, and connection hints (DNS prefetch, preconnect) and refreshes SHALL reach no host. Inline `data:` content, which involves no network, MAY render.

#### Scenario: An external resource

- **WHEN** the HTML references an image, stylesheet, font or frame on an HTTP(S) URL
- **THEN** no request reaches that URL, and the render still completes

#### Scenario: Hints and refreshes

- **WHEN** the HTML carries a DNS prefetch, a preconnect or a meta refresh naming a host
- **THEN** no lookup and no connection reaches that host, and the render still completes

#### Scenario: The reports as they are

- **WHEN** a live report PDF and an issued PDF are rendered
- **THEN** each renders as before, with the same pages and text
