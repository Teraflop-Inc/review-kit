## Pull request labels (review-kit)

When you open a pull request, label it so reviewers know how much attention it needs:

- `needs-review`: changes behavior, touches shared code, or you are not confident in it.
- `fyi`: low risk (docs, config, small refactors, test-only). The automated review will report Important findings only.

Add one line to the PR body explaining the label, for example: `Label: fyi (docs-only change to the setup guide)`.
Create the labels once with `gh label create needs-review` and `gh label create fyi` if they do not exist.
