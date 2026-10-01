# DEBUG LOG --- Expense Attachment & Draft Workflow

## 1. Debug Session Overview

**Application:** SiteExpense\
**Primary file changed:** `public/app.js`\
**Backend/database changes:** None\
**PostgreSQL impact:** None

This debugging pass focused on the expense attachment and local-draft
workflow.

The goals were to:

-   keep draft data and attachments locally instead of creating database
    drafts;
-   restore draft data and attachments after reload;
-   clear draft state after successful submission;
-   prevent old attachments from leaking into a new expense;
-   allow users to remove incorrectly attached evidence;
-   make draft-save failures visible to the user;
-   reduce unnecessary clicks when a checker views an attachment;
-   clean up temporary image preview URLs.

All changes were made incrementally and tested.

------------------------------------------------------------------------

# 2. Attachment State

Attachments are maintained in:

``` js
ExpenseForm.files
```

The same collection is used for:

-   attachment previews;
-   local draft saving;
-   final submission.

Accepted evidence includes:

-   images;
-   PDF files.

The file input uses:

``` html
accept="image/*,application/pdf"
```

This allows the attachment workflow to remain entirely in the frontend
until the expense is actually submitted.

------------------------------------------------------------------------

# 3. Old Attachment Leakage After Submission

## Problem

A draft containing attachments could be submitted successfully, but when
the user started another expense and added new attachments, attachments
from the previous expense could appear again.

The local draft itself could be cleared while the in-memory:

``` js
ExpenseForm.files
```

array still contained the previous `File` objects.

## Fix

The attachment state is cleared after successful final submission along
with the local draft state.

The intended lifecycle is:

``` text
Draft / current form
      ↓
Submit successfully
      ↓
Clear local draft
      ↓
Clear ExpenseForm.files
      ↓
New expense starts clean
```

## Result

**Tested successfully.**

Old attachments no longer reappear in a new expense after a previous
draft has been submitted.

------------------------------------------------------------------------

# 4. Local Draft Attachments

## Requirement

Saving an expense as a draft must keep both:

-   form data;
-   attached evidence.

The draft is stored locally using IndexedDB rather than being submitted
to PostgreSQL.

The browser can therefore retain:

``` text
Expense fields
+
Image/PDF files
```

between page reloads.

## Result

**Tested successfully.**

A saved draft can be restored after reloading the page, including its
attachments.

------------------------------------------------------------------------

# 5. Attachment Removal

## Problem

A user could accidentally attach the wrong evidence before submitting an
expense, but there was previously no way to remove an individual
attachment.

This was especially relevant for checker users because they may review a
large number of expenses and attachments during the day.

## Requirement

The desired workflow is:

``` text
Attach evidence
      ↓
Notice wrong file
      ↓
Remove wrong file
      ↓
Attach correct file
      ↓
Save Draft / Submit
```

## Implementation

A `removeFile(index)` operation was added to remove the selected item
from:

``` js
this.files
```

The attachment preview now displays a visible `×` button for each
attachment.

The attachment's array index identifies which file is removed.

Conceptually:

``` js
removeFile(index) {
  this.files.splice(index, 1);
}
```

The preview is then rebuilt so the removed attachment disappears
immediately.

## Important persistence behavior

Removing a file from the current form does **not** immediately overwrite
the saved IndexedDB draft.

The saved draft is updated only when the user presses **Save Draft**.

Therefore:

### Remove and save

``` text
Saved draft:
A B C

Load:
A B C

Remove B:
A C

Save Draft:
A C

Reload:
A C
```

### Remove without saving

``` text
Saved draft:
A B C

Load:
A B C

Remove B:
A C

Close without saving

Load draft again:
A B C
```

This was intentional. It prevents an accidental removal from permanently
modifying the saved draft unless the user explicitly saves it.

## Testing

Both behaviors were tested successfully.

**Status: PASS**

------------------------------------------------------------------------

# 6. Object URL Cleanup

## Problem

Image previews use:

``` js
URL.createObjectURL(file)
```

Each generated object URL represents a temporary browser resource.

Because a checker can work through many expenses and attachments in a
day, repeatedly generating preview URLs without releasing old ones could
unnecessarily retain browser memory.

## Implementation

A tracking array was added:

``` js
previewUrls: []
```

Before rebuilding the attachment preview, existing URLs are released:

``` js
this.previewUrls.forEach(url => URL.revokeObjectURL(url));
this.previewUrls = [];
```

When a new image preview URL is created, it is stored:

``` js
const url = URL.createObjectURL(f);
this.previewUrls.push(url);
```

PDF previews do not create image object URLs.

## Result

The preview system now releases the previous image preview URLs whenever
the preview is rebuilt.

This is a browser-memory cleanup improvement and does not alter the
actual uploaded files or database data.

------------------------------------------------------------------------

# 7. Draft Save Failure Handling

## Problem

Draft saving uses IndexedDB.

If IndexedDB saving failed, the user needed to be told explicitly that
the draft had **not** been saved.

A secondary backup-storage system was not required.

## Requirement

If local draft saving fails:

-   do not claim success;
-   do not create a backup storage mechanism;
-   notify the user;
-   leave the form available so they can try again.

## Fix

`saveDraft()` was wrapped in `try/catch`.

Successful save:

``` text
IndexedDB save
      ↓
Success
      ↓
"Draft saved locally"
```

Failure:

``` text
IndexedDB save
      ↓
Error
      ↓
"Draft could not be saved. Please try again."
```

The form remains open.

## Testing

The failure path was deliberately simulated in the browser by
temporarily replacing the draft save function with one that throws an
error.

The application correctly displayed:

> Draft could not be saved. Please try again.

The page was then refreshed to restore the normal function and normal
draft saving was tested again.

**Status: PASS**

------------------------------------------------------------------------

# 8. Attachment Validation Message

## Problem

The application accepts both images and PDFs, but the submission error
message previously said:

``` text
Attach at least one photo/image before submitting
```

That wording did not accurately describe all accepted evidence types.

## Change

The message was changed to:

``` text
Attach at least one file before submitting
```

The validation itself was not changed.

## Result

**Tested successfully.**

------------------------------------------------------------------------

# 9. Image Viewer / Expense Detail UX Bug

## Problem

When a checker was viewing an expense and opened an attachment, the
attachment viewer replaced the existing expense-detail modal.

The workflow was:

``` text
Expense detail
      ↓
Open attachment
      ↓
Attachment viewer replaces expense detail
      ↓
Close attachment
      ↓
User returns to expense list
```

This forced the checker to find and reopen the expense.

Checker feedback was essentially:

> Make it so that I don't have to click this much.

## Requirement

The expense-detail modal should remain open underneath the attachment
viewer.

Desired workflow:

``` text
Expense detail
      ↓
Open attachment
      ↓
Attachment viewer opens on top
      ↓
Close attachment viewer
      ↓
Same expense detail remains open
```

## Fix

The attachment viewer was changed to create a separate overlay on top of
the existing expense-detail modal instead of replacing it.

The underlying expense modal remains intact.

## Result

**Tested successfully.**

Closing the attachment viewer returns directly to the same expense
detail.

This reduces unnecessary navigation and clicks for checker users.

------------------------------------------------------------------------

# 10. Multiple Attachment Handling

The attachment workflow intentionally does not create an unnecessary
permanent stack of image modals.

The desired interaction is:

``` text
Expense detail
      ↓
Attachment viewer
      ↓
Close
      ↓
Expense detail
```

rather than:

``` text
Expense detail
      ↓
Image 1 modal
      ↓
Image 2 modal
      ↓
Image 3 modal
```

The expense detail remains the underlying context while the attachment
viewer is active.

------------------------------------------------------------------------

# 11. Shared Browser Drafts

A potential issue was considered where a single browser could contain
one local draft and different users might use the same workstation.

For the current SiteExpense workflow, this was intentionally left
unchanged.

The checker workflow generally involves one checker working from their
own browser/workstation and processing a large number of expenses.

Therefore, adding user-specific draft namespaces was considered
unnecessary for this debugging round.

------------------------------------------------------------------------

# 12. Dashboard UI Issue Deferred

During testing, another issue was noticed:

The **Balance In Hand** value can overflow outside its dashboard card
when the number is very large.

This is a CSS/layout issue, not an `app.js` feature issue.

It was intentionally **not changed during this round**.

It should be handled separately in the next UI/CSS debugging pass.

------------------------------------------------------------------------

# 13. Final Attachment/Draft Workflow

The resulting workflow is:

``` text
New Expense
    ↓
Enter expense details
    ↓
Attach image/PDF
    ↓
Preview evidence
    ↓
Remove incorrect attachment if necessary
    ↓
Attach correct evidence
    ↓
Save Draft
    ↓
Draft stored locally in IndexedDB
    ↓
Page reload
    ↓
Saved draft can be loaded
    ↓
Attachments restored
    ↓
Make changes if necessary
    ↓
Save Draft again
    ↓
Submit for review
    ↓
Draft cleared locally
    ↓
Attachment state cleared
    ↓
Next expense starts clean
```

------------------------------------------------------------------------

# 14. Regression Testing Completed

The following behaviors were tested:

-   Image attachment
-   PDF attachment
-   Multiple attachments
-   Duplicate attachment prevention
-   Individual attachment removal
-   Saving a draft with the remaining attachments
-   Reloading and restoring draft attachments
-   Removing an attachment without saving
-   Confirming an unsaved removal does not modify the stored draft
-   Draft save failure notification
-   Successful draft saving after failure-path testing
-   Clearing the local draft after final submission
-   Preventing old attachments from appearing in a new expense
-   Opening an attachment while viewing an expense
-   Closing the attachment viewer and returning to the same expense
-   Improved attachment validation wording
-   Temporary image preview URL cleanup

**Overall status: PASS**

------------------------------------------------------------------------

# 15. Database / Backend Impact

These changes are frontend and browser-local workflow changes.

They do not require PostgreSQL schema changes.

Saving a draft does not create a database expense:

``` text
Save Draft
    ↓
IndexedDB
    ↓
No PostgreSQL expense created
```

Final submission remains the point where the expense is sent to the
backend:

``` text
Submit for review
    ↓
POST /expenses
    ↓
Backend
    ↓
Database / uploaded evidence
```

Therefore the local-draft workflow remains independent of PostgreSQL
until submission.

------------------------------------------------------------------------

# 16. Debug Status

**Attachment and local-draft debugging round: COMPLETE**

All identified `app.js` attachment/draft issues covered by this
debugging round have been implemented and tested.

The dashboard Balance In Hand overflow remains deferred to a separate
CSS/UI debugging round.

No further changes should be made to the completed attachment/draft
logic unless a new reproducible regression is discovered.
