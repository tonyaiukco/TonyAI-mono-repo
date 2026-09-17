import { NotFoundException } from '@nestjs/common';

/**
 * No factor covers this (category, geography, year).
 *
 * A 404 like "Subsidiary not found", and the bulk importer has to tell the two
 * apart: one is a row the factor library cannot price yet (`no_factor`), the
 * other a reporting entity the caller may not name (`not_found`). It used to
 * read the message for the words "emission factor"; the class is the contract
 * now, and the sentence is free to change.
 */
export class NoEmissionFactorError extends NotFoundException {
  constructor(message: string) {
    super(message);
  }
}
