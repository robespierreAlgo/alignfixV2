# Contributing to AlignFix

Thank you for your interest in contributing to AlignFix! This document provides guidelines for contributing to the project.

## Code of Conduct

Please be respectful and constructive in all interactions with the project community.

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in the Issues section
2. If not, create a new issue with:
   - Clear title and description
   - Steps to reproduce
   - Expected vs actual behavior
   - Browser version and OS
   - Screenshots if applicable

### Suggesting Features

1. Check if the feature has already been suggested
2. Create a new issue with:
   - Clear description of the feature
   - Use case and rationale
   - Proposed implementation (if applicable)

### Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Test thoroughly
5. Commit with clear messages (`git commit -m 'Add amazing feature'`)
6. Push to your fork (`git push origin feature/amazing-feature`)
7. Open a Pull Request

#### Pull Request Guidelines

- Follow existing code style
- Add comments for complex logic
- Update documentation if needed
- Test in multiple browsers (Chrome, Firefox, Edge, Safari)
- Keep PRs focused on a single feature/fix

### Development Setup

See README.md for installation and setup instructions.

### Code Style

- **JavaScript**: Use modern ES6+ syntax, meaningful variable names
- **Python**: Follow PEP 8 guidelines
- **HTML/CSS**: Use semantic HTML, Bootstrap classes where appropriate
- **C++**: Follow existing style in fast_align directory

### Testing

- Test all changes in at least Chrome and Firefox
- Test with various corpus sizes (small, medium, large)
- Verify memory usage doesn't significantly increase
- Check browser console for errors

### Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Use imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit first line to 72 characters
- Reference issues and PRs liberally

### License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.

## Questions?

Feel free to open an issue for any questions about contributing.